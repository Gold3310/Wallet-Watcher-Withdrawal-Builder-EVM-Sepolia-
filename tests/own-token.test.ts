import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getCreateAddress, id, Interface } from "ethers";
import type { FunctionFragment } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { assertReachable } from "../src/infra/rpc/provider.js";
import { loadArtifact, parseArtifact } from "../src/domain/token/artifact.js";
import {
  buildDeposit,
  deployToken,
  mintToken,
  planDeploy,
  planMint,
} from "../src/domain/token/deploy.js";

const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TX_HASH = "0x" + "ab".repeat(32);

const artifact = loadArtifact();
const iface = new Interface(artifact.abi as never);

/** Deposit selector, derived rather than hardcoded. */
const DEPOSIT_SELECTOR = id("deposit()").slice(0, 10);

function mockSigner(nonce = 3, gas: bigint | null = 900_000n) {
  return {
    address: DEPLOYER,
    getNonce: vi.fn().mockResolvedValue(nonce),
    estimateGas: gas === null
      ? vi.fn().mockRejectedValue(new Error("cannot estimate"))
      : vi.fn().mockResolvedValue(gas),
    sendTransaction: vi.fn().mockResolvedValue({ hash: TX_HASH }),
  };
}

describe("the committed artifact", () => {
  it("still matches the source it was compiled from", () => {
    const require = createRequire(import.meta.url);
    let solc: { compile(input: string): string } | null = null;

    try {
      solc = require("solc") as { compile(input: string): string };
    } catch {
      // solc is a devDependency; without it there is nothing to compare.
      return;
    }

    const source = readFileSync(
      path.resolve(process.cwd(), "contracts", "WatcherWeth.sol"),
      "utf8",
    );
    const output = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: "Solidity",
          sources: { "WatcherWeth.sol": { content: source } },
          settings: {
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { "*": { "*": ["evm.bytecode.object"] } },
          },
        }),
      ),
    ) as {
      errors?: { severity: string }[];
      contracts?: Record<
        string,
        Record<string, { evm: { bytecode: { object: string } } }>
      >;
    };

    const errors = (output.errors ?? []).filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);

    const fresh = `0x${output.contracts!["WatcherWeth.sol"].WatcherWeth.evm.bytecode.object}`;
    expect(artifact.bytecode).toBe(fresh);
  });

  it("rejects an artifact with no bytecode", () => {
    expect(() =>
      parseArtifact(JSON.stringify({ abi: [{ type: "function" }] })),
    ).toThrow(/no usable bytecode/);
  });

  it("rejects an artifact with no ABI", () => {
    expect(() => parseArtifact(JSON.stringify({ bytecode: "0x1234" }))).toThrow(
      /no ABI/,
    );
  });
});

describe("the contract's shape", () => {
  const names = artifact.abi
    .filter((entry) => (entry as { type: string }).type === "function")
    .map((entry) => (entry as { name: string }).name);

  it("exposes the wrapped-ether lifecycle", () => {
    expect(names).toContain("deposit");
    expect(names).toContain("withdraw");
    expect(names).toContain("transfer");
    expect(names).toContain("transferFrom");
  });

  it("exposes ownership, transferable as Ownable always requires", () => {
    expect(names).toContain("owner");
    expect(names).toContain("transferOwnership");
    expect(names).toContain("renounceOwnership");
  });

  it("has no privileged mint — supply is created by locking ETH", () => {
    expect(names).not.toContain("mint");
    expect(names).not.toContain("mintTo");
  });

  it("has no hubPool or proposer gate, so the service reports no restriction", () => {
    expect(names).not.toContain("hubPool");
    expect(names).not.toContain("proposers");

    // The service treats a missing restricted destination as "no gate", so
    // reporting against this contract degrades to true rather than unknown.
    const ifaceNames = new Set(
      iface.fragments
        .filter((f): f is FunctionFragment => f.type === "function")
        .map((f) => f.name),
    );
    expect(ifaceNames.has("hubPool")).toBe(false);
  });

  it("is small enough to deploy", () => {
    // EIP-170 caps runtime code at 24576 bytes.
    expect((artifact.bytecode.length - 2) / 2).toBeLessThan(24576);
  });
});

describe("planning a deploy", () => {
  it("predicts the address without sending anything", async () => {
    const signer = mockSigner(3);
    const plan = await planDeploy(signer as never, artifact);

    expect(plan.from).toBe(DEPLOYER);
    expect(plan.predictedAddress).toBe(
      getCreateAddress({ from: DEPLOYER, nonce: 3 }),
    );
    expect(plan.broadcast).toBe(false);
    expect(plan.txHash).toBeNull();
    expect(plan.address).toBeNull();
    expect(plan.data).toContain(artifact.bytecode.slice(2));
  });

  it("leaves the address unknown when the nonce cannot be read", async () => {
    const signer = {
      address: DEPLOYER,
      getNonce: vi.fn().mockRejectedValue(new Error("no rpc")),
      estimateGas: vi.fn().mockResolvedValue(900_000n),
    };
    const plan = await planDeploy(signer as never, artifact);

    // A wrong address is worse than no address.
    expect(plan.predictedAddress).toBeNull();
    expect(plan.data).toContain(artifact.bytecode.slice(2));
  });

  it("reports gas when it can be estimated", async () => {
    const plan = await planDeploy(mockSigner() as never, artifact);
    expect(plan.gasEstimate).toBe("900000");
  });

  it("survives a refusal to estimate, since an unfunded account is normal", async () => {
    const plan = await planDeploy(mockSigner(0, null) as never, artifact);
    expect(plan.gasEstimate).toBeNull();
    expect(plan.predictedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("broadcasting a deploy", () => {
  it("sends the bytecode and reports the predicted address as final", async () => {
    const signer = mockSigner(7);
    const plan = await deployToken(signer as never, artifact, true);

    expect(signer.sendTransaction).toHaveBeenCalledWith({
      data: plan.data,
    });
    expect(plan.broadcast).toBe(true);
    expect(plan.txHash).toBe(TX_HASH);
    expect(plan.address).toBe(getCreateAddress({ from: DEPLOYER, nonce: 7 }));
  });

  it("sends nothing when not broadcasting", async () => {
    const signer = mockSigner();
    const plan = await deployToken(signer as never, artifact, false);

    expect(signer.sendTransaction).not.toHaveBeenCalled();
    expect(plan.txHash).toBeNull();
  });
});

describe("minting by depositing", () => {
  it("builds a deposit call carrying the ETH that mints it", () => {
    const amount = 10n ** 16n; // 0.01 ETH
    const plan = planMint(artifact, CONTRACT, mockSigner() as never, amount);

    expect(plan.data).toBe(DEPOSIT_SELECTOR);
    expect(buildDeposit(artifact, amount)).toBe(DEPOSIT_SELECTOR);
    expect(plan.value).toBe(amount.toString());
    expect(plan.contract).toBe(CONTRACT);
    expect(plan.broadcast).toBe(false);
  });

  it("sends value with the call when broadcasting", async () => {
    const signer = mockSigner();
    const amount = 10n ** 16n;
    const plan = await mintToken(
      artifact,
      CONTRACT,
      signer as never,
      amount,
      true,
    );

    expect(signer.sendTransaction).toHaveBeenCalledWith({
      to: CONTRACT,
      data: DEPOSIT_SELECTOR,
      value: amount,
    });
    expect(plan.txHash).toBe(TX_HASH);
  });

  it("sends nothing when not broadcasting", async () => {
    const signer = mockSigner();
    const plan = await mintToken(
      artifact,
      CONTRACT,
      signer as never,
      10n ** 16n,
      false,
    );

    expect(signer.sendTransaction).not.toHaveBeenCalled();
    expect(plan.txHash).toBeNull();
  });
});

describe("refusing to hang on a dead node", () => {
  it("gives up and names the setting to check", async () => {
    const dead = {
      getBlockNumber: () => new Promise<number>(() => {}), // never resolves
    };

    await expect(
      assertReachable(dead as never, 50),
    ).rejects.toThrow(/Could not reach the .* node at/);
  });

  it("says which environment variable is wrong", async () => {
    const dead = { getBlockNumber: () => new Promise<number>(() => {}) };

    await expect(assertReachable(dead as never, 50)).rejects.toThrow(
      /SEPOLIA_RPC_URL|MAINNET_RPC_URL/,
    );
  });

  it("resolves when the node answers", async () => {
    const live = { getBlockNumber: () => Promise.resolve(1234) };
    await expect(assertReachable(live as never, 50)).resolves.toBeUndefined();
  });
});
