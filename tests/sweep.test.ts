import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  getAddress,
  parseEther,
  parseUnits,
  Transaction,
  ZeroAddress,
} from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HUB_POOL_IMMUTABLE,
  hubPoolInterface,
  trackedContractInterface,
} from "../src/domain/assets/abi.js";
import { deriveWalletAtIndex } from "../src/domain/wallet/wallet.service.js";
import { withConfig } from "./helpers/withConfig.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const W0 = deriveWalletAtIndex(TEST_MNEMONIC, 0).address;
const W1 = deriveWalletAtIndex(TEST_MNEMONIC, 1).address;
const W2 = deriveWalletAtIndex(TEST_MNEMONIC, 2).address;
const W3 = deriveWalletAtIndex(TEST_MNEMONIC, 3).address;
const W4 = deriveWalletAtIndex(TEST_MNEMONIC, 4).address;

const DESTINATION = "0x2EF4c86Bdd42884339643D2beCB32988D90A46F4";
const OTHER_DESTINATION = "0x8888888888888888888888888888888888888888";
const OWNER = "0x1111111111111111111111111111111111111111";
const WETH = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x5555555555555555555555555555555555555555";
const TOKEN_API_SECRET = "secret-sweep-token";
const ZERO_BYTES32 = "0x" + "00".repeat(32);

const BASE_ENV: Record<string, string | undefined> = {
  CHAIN: undefined,
  MAINNET_ENABLED: undefined,
  MAINNET_RPC_URL: undefined,
  MAINNET_MAX_TX_VALUE_WEI: undefined,
  WALLET_MNEMONIC: TEST_MNEMONIC,
  WALLET_COUNT: "5",
  SEPOLIA_RPC_URL: "https://sepolia.example",
  DATABASE_PATH: ":memory:",
  API_TOKENS: undefined,
  OWNER_ADDRESS: undefined,
  WITHDRAWAL_ALLOWLIST: undefined,
  WITHDRAWAL_MAX_VALUE_WEI: undefined,
  WITHDRAWAL_MAX_PER_WINDOW_WEI: undefined,
  WITHDRAWAL_WINDOW_SECONDS: undefined,
  TRACKED_CONTRACT: undefined,
  TRACKED_TOKENS: undefined,
  MAINNET_TRACKED_CONTRACT: undefined,
  SEPOLIA_TRACKED_CONTRACT: undefined,
  GASLESS_RELAY_ENDPOINT: undefined,
  GASLESS_API_KEY: undefined,
};

interface MockProviderOptions {
  ethBalances?: Record<string, bigint>;
  nonces?: Record<string, number>;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  tokenBalances?: Record<string, Record<string, bigint>>;
  symbols?: Record<string, string>;
  decimals?: Record<string, number>;
  hubPools?: Record<string, string>;
  proposers?: Record<string, string[]>;
  rootBundleProposer?: Record<string, string>;
  failingCalls?: Record<string, string[]>;
  estimateGas?: (tx: { from?: string; to?: string; data?: string }) => Promise<bigint>;
  broadcastTransaction?: ReturnType<typeof vi.fn>;
  waitForTransaction?: (hash: string) => Promise<{ status: number } | null>;
}

const enc = (name: string, values: unknown[]) =>
  trackedContractInterface.encodeFunctionResult(name, values as never[]);

function createMockProvider(options: MockProviderOptions = {}) {
  const maxFeePerGas = options.maxFeePerGas ?? 2_000_000_000n;
  const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? 1_000_000_000n;
  let txSeq = 0;

  const broadcastTransaction =
    options.broadcastTransaction ??
    vi.fn(async () => {
      txSeq += 1;
      return {
        hash: `0x${txSeq.toString(16).padStart(64, "a")}`,
      };
    });

  const provider: Record<string, unknown> = {
    getBalance: vi.fn(async (address: string) => {
      return options.ethBalances?.[address.toLowerCase()] ?? 0n;
    }),
    getTransactionCount: vi.fn(async (address: string) => {
      return options.nonces?.[address.toLowerCase()] ?? 0;
    }),
    getFeeData: vi.fn(async () => ({
      maxFeePerGas,
      maxPriorityFeePerGas,
    })),
    estimateGas: vi.fn(async (tx: { from?: string; to?: string; data?: string }) => {
      if (options.estimateGas) {
        return options.estimateGas(tx);
      }
      return 60_000n;
    }),
    broadcastTransaction,
    call: vi.fn(async ({ to, data }: { to: string; data: string }) => {
      const key = to.toLowerCase();
      const fnName =
        trackedContractInterface.getFunction(data.slice(0, 10))?.name ??
        hubPoolInterface.getFunction(data.slice(0, 10))?.name;

      if (options.failingCalls?.[key]?.includes(fnName ?? "")) {
        throw new Error(`${fnName} reverted`);
      }

      switch (fnName) {
        case "balanceOf": {
          const [holder] = trackedContractInterface.decodeFunctionData("balanceOf", data);
          const holderKey = String(holder).toLowerCase();
          return enc("balanceOf", [options.tokenBalances?.[key]?.[holderKey] ?? 0n]);
        }
        case "decimals":
          return enc("decimals", [options.decimals?.[key] ?? 18]);
        case "symbol":
          return enc("symbol", [options.symbols?.[key] ?? "TKN"]);
        case "name":
          return enc("name", ["Mock Token"]);
        case "totalSupply":
          return enc("totalSupply", [0n]);
        case "owner":
          return enc("owner", [OWNER]);
        case "hubPool":
          if (!options.hubPools?.[key]) {
            throw new Error("no hubPool");
          }
          return enc("hubPool", [options.hubPools[key]]);
        case "proposers": {
          const [holder] = trackedContractInterface.decodeFunctionData("proposers", data);
          const allowed = options.proposers?.[key] ?? [];
          return enc("proposers", [allowed.includes(String(holder).toLowerCase())]);
        }
        case "rootBundleProposal": {
          const proposer = options.rootBundleProposer?.[key] ?? ZeroAddress;
          return hubPoolInterface.encodeFunctionResult("rootBundleProposal", [
            [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, 0n, proposer, 0, 0],
          ]);
        }
        default:
          throw new Error(`Unexpected call ${fnName}`);
      }
    }),
  };

  if (options.waitForTransaction) {
    provider.waitForTransaction = vi.fn(options.waitForTransaction);
  }

  return { provider, broadcastTransaction };
}

async function withSweepContext<T>(
  env: Record<string, string | undefined>,
  mockOptions: MockProviderOptions,
  fn: (ctx: {
    createSweep: typeof import("../src/domain/sweep/sweep.service.js").createSweep;
    database: typeof import("../src/infra/db/database.js");
    broadcastTransaction: ReturnType<typeof vi.fn>;
    provider: Record<string, unknown>;
  }) => Promise<T>,
): Promise<T> {
  return withConfig({ ...BASE_ENV, ...env }, async () => {
    const { initializeWallets } = await import(
      "../src/domain/balance/balance.service.js"
    );
    const { createSweep } = await import(
      "../src/domain/sweep/sweep.service.js"
    );
    const { setProvider } = await import("../src/infra/rpc/provider.js");
    const database = await import("../src/infra/db/database.js");

    const { provider, broadcastTransaction } = createMockProvider(mockOptions);
    setProvider(provider as never);
    initializeWallets();

    try {
      return await fn({ createSweep, database, broadcastTransaction, provider });
    } finally {
      database.closeDatabase();
    }
  });
}

async function withSweepServer(
  env: Record<string, string | undefined>,
  mockOptions: MockProviderOptions,
  fn: (ctx: {
    baseUrl: string;
    broadcastTransaction: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
): Promise<void> {
  await withConfig({ ...BASE_ENV, ...env }, async () => {
    const { createApp } = await import("../src/api/app.js");
    const { initializeWallets } = await import(
      "../src/domain/balance/balance.service.js"
    );
    const { setProvider } = await import("../src/infra/rpc/provider.js");
    const database = await import("../src/infra/db/database.js");

    const { provider, broadcastTransaction } = createMockProvider(mockOptions);
    setProvider(provider as never);
    initializeWallets();

    const app = createApp();
    const server: import("node:http").Server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      await fn({ baseUrl, broadcastTransaction });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.closeDatabase();
    }
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("sweep planning and native ETH sweeping", () => {
  it("plans across all wallets: ready, zero, dust, and destination-equals-wallet", async () => {
    await withSweepContext(
      {},
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.5"),
          [W1.toLowerCase()]: 0n,
          // 40_000 gwei < 21_000 * 2 gwei (42_000 gwei)
          [W2.toLowerCase()]: 40_000_000_000_000n,
          [W3.toLowerCase()]: parseEther("1"),
          [W4.toLowerCase()]: parseEther("0.25"),
        },
      },
      async ({ createSweep, broadcastTransaction }) => {
        // Consolidate everything into W3.
        const report = await createSweep({
          toAddress: W3,
          broadcast: false,
        });

        expect(broadcastTransaction).not.toHaveBeenCalled();
        expect(report.broadcast).toBe(false);
        expect(report.summary.walletsScanned).toBe(5);
        expect(report.summary.walletsWithActions).toBe(2);
        expect(report.summary.stepsReady).toBe(2);
        expect(report.summary.stepsSkipped).toBe(2);
        expect(report.summary.stepsBlocked).toBe(0);

        const gasCost = 21_000n * 2_000_000_000n;
        const expectedTotal = parseEther("0.75") - gasCost * 2n;
        expect(BigInt(report.summary.totalEthWei)).toBe(expectedTotal);

        expect(report.wallets[0]!.status).toBe("ready");
        expect(report.wallets[1]!.status).toBe("skipped");
        expect(report.wallets[1]!.steps[0]!.reason).toMatch(/Zero ETH/);
        expect(report.wallets[2]!.status).toBe("skipped");
        expect(report.wallets[2]!.steps[0]!.reason).toMatch(/does not exceed estimated gas/);
        expect(report.wallets[3]!.status).toBe("skipped");
        expect(report.wallets[3]!.reason).toMatch(/already the destination/);
        expect(report.wallets[4]!.status).toBe("ready");
      },
    );
  });

  it("does not consume nonces while planning, then broadcasts cleanly starting at nonce 0", async () => {
    await withSweepContext(
      {},
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.3"),
          [W1.toLowerCase()]: parseEther("0.1"),
        },
      },
      async ({ createSweep, broadcastTransaction, database }) => {
        const plan = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0, 1],
          broadcast: false,
        });
        expect(plan.wallets[0]!.steps[0]!.nonce).toBe(0);
        expect(broadcastTransaction).not.toHaveBeenCalled();

        const sent = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0, 1],
          broadcast: true,
          actor: OWNER,
        });
        expect(broadcastTransaction).toHaveBeenCalledTimes(2);
        expect(sent.summary.stepsBroadcast).toBe(2);
        expect(sent.wallets[0]!.steps[0]!.nonce).toBe(0);
        expect(sent.wallets[1]!.steps[0]!.nonce).toBe(0);

        const rawTx0 = broadcastTransaction.mock.calls[0]![0] as string;
        const parsed0 = Transaction.from(rawTx0);
        expect(parsed0.from).toBe(W0);
        expect(parsed0.to).toBe(DESTINATION);
        expect(parsed0.nonce).toBe(0);

        const wallet0 = database.getWalletByIndex(0)!;
        const outflows = database
          .getLedgerForWallet(wallet0.id)
          .filter((row) => row.type === "outflow");
        expect(outflows).toHaveLength(1);
        expect(outflows[0]!.actor).toBe(OWNER);
        expect(outflows[0]!.amount_wei).toBe(sent.wallets[0]!.steps[0]!.amountRaw);
      },
    );
  });
});

describe("unwrapping wrapped ETH and sweeping tokens", () => {
  it("unwraps then sweeps estimated ETH without confirmation waiting, sequential nonces", async () => {
    await withSweepContext(
      { TRACKED_CONTRACT: WETH },
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.1"),
          [WETH.toLowerCase()]: parseEther("5"),
        },
        tokenBalances: {
          [WETH.toLowerCase()]: {
            [W0.toLowerCase()]: parseEther("2"),
          },
        },
        symbols: { [WETH.toLowerCase()]: "wWETH" },
      },
      async ({ createSweep, broadcastTransaction }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          unwrap: true,
          broadcast: true,
        });

        expect(broadcastTransaction).toHaveBeenCalledTimes(2);
        const [unwrapStep, ethStep] = report.wallets[0]!.steps;

        expect(unwrapStep).toMatchObject({
          kind: "unwrap",
          status: "broadcast",
          contract: WETH,
          amountRaw: parseEther("2").toString(),
          nonce: 0,
        });
        expect(ethStep).toMatchObject({
          kind: "eth",
          status: "broadcast",
          nonce: 1,
        });

        const unwrapGas = 60_000n * 2_000_000_000n;
        const ethGas = 21_000n * 2_000_000_000n;
        expect(BigInt(ethStep!.amountRaw)).toBe(
          parseEther("2.1") - unwrapGas - ethGas,
        );

        const parsedUnwrap = Transaction.from(broadcastTransaction.mock.calls[0]![0] as string);
        expect(parsedUnwrap.to).toBe(WETH);
        expect(parsedUnwrap.value).toBe(0n);
        expect(parsedUnwrap.data).toBe(
          trackedContractInterface.encodeFunctionData("withdraw", [parseEther("2")]),
        );
      },
    );
  });

  it("waits for unwrap confirmation and re-reads live ETH balance when provider supports it", async () => {
    const ethByAddr: Record<string, bigint> = {
      [W0.toLowerCase()]: parseEther("0.1"),
      [WETH.toLowerCase()]: parseEther("5"),
    };

    await withSweepContext(
      { TRACKED_CONTRACT: WETH },
      {
        ethBalances: ethByAddr,
        tokenBalances: {
          [WETH.toLowerCase()]: {
            [W0.toLowerCase()]: parseEther("2"),
          },
        },
        symbols: { [WETH.toLowerCase()]: "wWETH" },
        waitForTransaction: async () => {
          // Suppose actual gas used was half of maxFee * gasLimit.
          ethByAddr[W0.toLowerCase()] = parseEther("2.095");
          return { status: 1 };
        },
      },
      async ({ createSweep }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          unwrap: true,
          broadcast: true,
        });

        const ethStep = report.wallets[0]!.steps[1]!;
        const ethGas = 21_000n * 2_000_000_000n;
        expect(ethStep.status).toBe("broadcast");
        expect(BigInt(ethStep.amountRaw)).toBe(parseEther("2.095") - ethGas);
        expect(ethStep.estimatedAfterPriorSteps).toBeUndefined();
      },
    );
  });

  it("blocks ETH sweep if prior unwrap reverted on chain", async () => {
    await withSweepContext(
      { TRACKED_CONTRACT: WETH },
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.1"),
          [WETH.toLowerCase()]: parseEther("5"),
        },
        tokenBalances: {
          [WETH.toLowerCase()]: { [W0.toLowerCase()]: parseEther("2") },
        },
        waitForTransaction: async () => ({ status: 0 }),
      },
      async ({ createSweep, broadcastTransaction }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          unwrap: true,
          broadcast: true,
        });

        expect(broadcastTransaction).toHaveBeenCalledTimes(1);
        expect(report.wallets[0]!.steps[0]!.status).toBe("broadcast");
        expect(report.wallets[0]!.steps[1]!.status).toBe("blocked");
        expect(report.wallets[0]!.steps[1]!.reason).toMatch(/reverted on chain/);
      },
    );
  });

  it("tracks wrapper ETH reserve across wallets so unbacked unwraps are blocked", async () => {
    await withSweepContext(
      { TRACKED_CONTRACT: WETH },
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.1"),
          [W1.toLowerCase()]: parseEther("0.1"),
          // Wrapper only backs 4 ETH total, while W0 + W1 hold 6 wrapped ETH.
          [WETH.toLowerCase()]: parseEther("4"),
        },
        tokenBalances: {
          [WETH.toLowerCase()]: {
            [W0.toLowerCase()]: parseEther("3"),
            [W1.toLowerCase()]: parseEther("3"),
          },
        },
      },
      async ({ createSweep }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0, 1],
          unwrap: true,
          broadcast: false,
        });

        expect(report.wallets[0]!.steps[0]!.status).toBe("ready");
        expect(report.wallets[1]!.steps[0]!.status).toBe("blocked");
        expect(report.wallets[1]!.steps[0]!.reason).toMatch(/not fully backed/);
      },
    );
  });

  it("unwraps explicit unwrapContracts, transfers other ERC-20s, and sweeps remaining ETH", async () => {
    await withSweepContext(
      {},
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.05"),
          [WETH.toLowerCase()]: parseEther("2"),
        },
        tokenBalances: {
          [WETH.toLowerCase()]: { [W0.toLowerCase()]: parseEther("1") },
          [TOKEN.toLowerCase()]: { [W0.toLowerCase()]: parseUnits("250", 6) },
        },
        symbols: { [WETH.toLowerCase()]: "wWETH", [TOKEN.toLowerCase()]: "USDC" },
        decimals: { [WETH.toLowerCase()]: 18, [TOKEN.toLowerCase()]: 6 },
      },
      async ({ createSweep, broadcastTransaction }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          tokens: [TOKEN],
          unwrapContracts: [WETH],
          broadcast: true,
        });

        expect(broadcastTransaction).toHaveBeenCalledTimes(3);
        expect(report.wallets[0]!.steps.map((s) => [s.kind, s.nonce, s.status])).toEqual([
          ["unwrap", 0, "broadcast"],
          ["erc20", 1, "broadcast"],
          ["eth", 2, "broadcast"],
        ]);
        expect(report.wallets[0]!.steps[1]!.amountFormatted).toBe("250.0");

        const transferTx = Transaction.from(broadcastTransaction.mock.calls[1]![0] as string);
        expect(transferTx.to).toBe(TOKEN);
        expect(transferTx.data).toBe(
          trackedContractInterface.encodeFunctionData("transfer", [
            DESTINATION,
            parseUnits("250", 6),
          ]),
        );
      },
    );
  });

  it("blocks gas-blocked token wallets with exact shortfall without stopping healthy wallets", async () => {
    await withSweepContext(
      {},
      {
        ethBalances: {
          [W0.toLowerCase()]: 0n, // gas-blocked for ERC-20
          [W1.toLowerCase()]: parseEther("0.1"),
        },
        tokenBalances: {
          [TOKEN.toLowerCase()]: {
            [W0.toLowerCase()]: parseUnits("500", 6),
            [W1.toLowerCase()]: parseUnits("100", 6),
          },
        },
        decimals: { [TOKEN.toLowerCase()]: 6 },
      },
      async ({ createSweep, broadcastTransaction }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0, 1],
          tokens: [TOKEN],
          broadcast: true,
        });

        expect(report.wallets[0]!.steps[0]!.status).toBe("blocked");
        expect(report.wallets[0]!.steps[0]!.reason).toMatch(/gas-blocked/);
        expect(report.wallets[0]!.steps[0]!.shortfallWei).toBe(
          (60_000n * 2_000_000_000n).toString(),
        );

        expect(report.wallets[1]!.steps[0]!.status).toBe("broadcast");
        expect(report.wallets[1]!.steps[1]!.status).toBe("broadcast");
        expect(broadcastTransaction).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("warns and continues ETH sweep when an implicit TRACKED_CONTRACT is unreadable on the chain", async () => {
    await withSweepContext(
      { TRACKED_CONTRACT: TOKEN },
      {
        ethBalances: { [W0.toLowerCase()]: parseEther("0.2") },
        failingCalls: { [TOKEN.toLowerCase()]: ["balanceOf"] },
      },
      async ({ createSweep }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          broadcast: false,
        });

        expect(report.notes.join(" ")).toMatch(/not deployed on this chain/);
        expect(report.wallets[0]!.steps[0]!.status).toBe("skipped");
        expect(report.wallets[0]!.steps[1]!.status).toBe("ready");
      },
    );
  });

  it("blocks transfers directly TO hubPool while wallet is the unapproved pending proposer", async () => {
    await withSweepContext(
      { TRACKED_CONTRACT: TOKEN },
      {
        ethBalances: { [W0.toLowerCase()]: parseEther("0.1") },
        tokenBalances: { [TOKEN.toLowerCase()]: { [W0.toLowerCase()]: parseEther("1") } },
        hubPools: { [TOKEN.toLowerCase()]: HUB_POOL_IMMUTABLE },
        rootBundleProposer: { [HUB_POOL_IMMUTABLE.toLowerCase()]: W0 },
      },
      async ({ createSweep }) => {
        const blocked = await createSweep({
          toAddress: HUB_POOL_IMMUTABLE,
          walletIndices: [0],
          includeNative: false,
          broadcast: false,
        });
        expect(blocked.wallets[0]!.steps[0]!.status).toBe("blocked");
        expect(blocked.wallets[0]!.steps[0]!.reason).toMatch(/pending root-bundle proposer/);

        const normal = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          includeNative: false,
          broadcast: false,
        });
        expect(normal.wallets[0]!.steps[0]!.status).toBe("ready");
      },
    );
  });

  it("supports ETH-only override (tokens: []) and token-only sweep (includeNative: false)", async () => {
    await withSweepContext(
      { TRACKED_CONTRACT: TOKEN },
      {
        ethBalances: { [W0.toLowerCase()]: parseEther("0.3") },
        tokenBalances: { [TOKEN.toLowerCase()]: { [W0.toLowerCase()]: parseEther("2") } },
      },
      async ({ createSweep }) => {
        const ethOnly = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          tokens: [],
          broadcast: false,
        });
        expect(ethOnly.wallets[0]!.steps.map((s) => s.kind)).toEqual(["eth"]);

        const tokenOnly = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          includeNative: false,
          broadcast: false,
        });
        expect(tokenOnly.wallets[0]!.steps.map((s) => s.kind)).toEqual(["erc20"]);
      },
    );
  });
});

describe("guardrails, failure handling, and sponsored relayer", () => {
  it("rejects ZeroAddress and non-allowlisted destinations before any signing", async () => {
    await withSweepContext(
      { WITHDRAWAL_ALLOWLIST: DESTINATION },
      { ethBalances: { [W0.toLowerCase()]: parseEther("1") } },
      async ({ createSweep }) => {
        await expect(
          createSweep({ toAddress: ZeroAddress, broadcast: true }),
        ).rejects.toThrow(/zero address/);

        await expect(
          createSweep({ toAddress: OTHER_DESTINATION, broadcast: true }),
        ).rejects.toThrow(/not in the withdrawal allowlist/);
      },
    );
  });

  it("enforces mainnet per-tx limit on estimated post-unwrap ETH BEFORE broadcasting unwrap", async () => {
    await withSweepContext(
      {
        CHAIN: "mainnet",
        MAINNET_ENABLED: "true",
        MAINNET_RPC_URL: "https://mainnet.example",
        API_TOKENS: `${OWNER}:${TOKEN_API_SECRET}`,
        TRACKED_CONTRACT: WETH,
      },
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.06"),
          [WETH.toLowerCase()]: parseEther("1"),
        },
        tokenBalances: {
          // 0.06 ETH + 0.06 WETH = ~0.12 ETH > default 0.1 ETH mainnet cap
          [WETH.toLowerCase()]: { [W0.toLowerCase()]: parseEther("0.06") },
        },
      },
      async ({ createSweep, broadcastTransaction }) => {
        await expect(
          createSweep({
            toAddress: DESTINATION,
            walletIndices: [0],
            unwrap: true,
            broadcast: true,
          }),
        ).rejects.toThrow(/exceeds the mainnet per-transaction limit/);

        expect(broadcastTransaction).not.toHaveBeenCalled();
      },
    );
  });

  it("enforces velocity limit per wallet before broadcasting across multiple wallets", async () => {
    await withSweepContext(
      { WITHDRAWAL_MAX_PER_WINDOW_WEI: parseEther("0.5").toString() },
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.2"),
          [W1.toLowerCase()]: parseEther("0.8"),
        },
      },
      async ({ createSweep, broadcastTransaction }) => {
        await expect(
          createSweep({ toAddress: DESTINATION, broadcast: true }),
        ).rejects.toThrow(/remaining withdrawal allowance/);

        // Wallet 0 was NOT broadcast because wallet 1 tripped the preflight check.
        expect(broadcastTransaction).not.toHaveBeenCalled();
      },
    );
  });

  it("releases nonce and blocks later steps on a wallet if broadcast fails, while continuing other wallets", async () => {
    let calls = 0;
    const broadcastMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("mempool rejected");
      }
      return { hash: "0x" + "bb".repeat(32) };
    });

    await withSweepContext(
      {},
      {
        ethBalances: {
          [W0.toLowerCase()]: parseEther("0.2"),
          [W1.toLowerCase()]: parseEther("0.2"),
          [WETH.toLowerCase()]: parseEther("5"),
        },
        tokenBalances: {
          [WETH.toLowerCase()]: { [W0.toLowerCase()]: parseEther("1") },
        },
        tokens: undefined,
        broadcastTransaction: broadcastMock,
      } as MockProviderOptions,
      async ({ createSweep }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0, 1],
          tokens: [WETH],
          unwrap: true,
          broadcast: true,
        });

        expect(report.wallets[0]!.status).toBe("failed");
        expect(report.wallets[0]!.steps[0]!.status).toBe("failed");
        expect(report.wallets[0]!.steps[0]!.reason).toMatch(/mempool rejected/);
        expect(report.wallets[0]!.steps[1]!.status).toBe("blocked");
        expect(report.wallets[1]!.steps[1]!.status).toBe("broadcast");

        // Nonce 0 on wallet 0 was released on direct-relayer error, so a retry starts at 0.
        const { peekNonce } = await import("../src/domain/wallet/nonce.manager.js");
        const retryNonce = await peekNonce(0, W0, {
          getTransactionCount: vi.fn().mockResolvedValue(0),
        } as never);
        expect(retryNonce).toBe(0);
      },
    );
  });

  it("does not release nonce when SponsoredRelayer errors (submission status unknown)", async () => {
    const relayFetch = vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", relayFetch);

    await withSweepContext(
      {
        GASLESS_RELAY_ENDPOINT: "https://relay.example/tx",
        GASLESS_API_KEY: "relay-secret",
      },
      {
        ethBalances: { [W0.toLowerCase()]: 0n },
        tokenBalances: { [TOKEN.toLowerCase()]: { [W0.toLowerCase()]: parseUnits("10", 6) } },
      },
      async ({ createSweep }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          tokens: [TOKEN],
          broadcast: true,
        });

        expect(report.wallets[0]!.steps[0]!.status).toBe("failed");
        expect(report.wallets[0]!.steps[0]!.reason).toMatch(/reusing nonce 0 risks a duplicate/);

        const { peekNonce } = await import("../src/domain/wallet/nonce.manager.js");
        const nextNonce = await peekNonce(0, W0, {
          getTransactionCount: vi.fn().mockResolvedValue(0),
        } as never);
        expect(nextNonce).toBe(1);
      },
    );
  });

  it("submits ERC-20 transfers via SponsoredRelayer even when wallet has zero ETH", async () => {
    const relayFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hash: "0x" + "cc".repeat(32) }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", relayFetch);

    await withSweepContext(
      {
        GASLESS_RELAY_ENDPOINT: "https://relay.example/tx",
        GASLESS_API_KEY: "relay-secret",
      },
      {
        ethBalances: { [W0.toLowerCase()]: 0n },
        tokenBalances: { [TOKEN.toLowerCase()]: { [W0.toLowerCase()]: parseUnits("50", 6) } },
        decimals: { [TOKEN.toLowerCase()]: 6 },
      },
      async ({ createSweep }) => {
        const report = await createSweep({
          toAddress: DESTINATION,
          walletIndices: [0],
          tokens: [TOKEN],
          broadcast: true,
        });

        expect(report.relayer).toBe("sponsored");
        expect(report.wallets[0]!.steps[0]!.status).toBe("broadcast");
        expect(report.wallets[0]!.steps[1]!.status).toBe("skipped"); // 0 ETH
        expect(relayFetch).toHaveBeenCalledTimes(1);
      },
    );
  });
});

describe("POST /withdrawals/sweep HTTP endpoint", () => {
  it("enforces sole-owner auth, idempotency, and returns plan vs broadcast", async () => {
    await withSweepServer(
      {
        OWNER_ADDRESS: OWNER,
        API_TOKENS: `${OWNER}:${TOKEN_API_SECRET}`,
        WITHDRAWAL_ALLOWLIST: DESTINATION,
      },
      {
        ethBalances: { [W0.toLowerCase()]: parseEther("0.4") },
      },
      async ({ baseUrl, broadcastTransaction }) => {
        const anon = await fetch(`${baseUrl}/withdrawals/sweep`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toAddress: DESTINATION }),
        });
        expect(anon.status).toBe(401);

        const auth = {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN_API_SECRET}`,
        };

        const badZero = await fetch(`${baseUrl}/withdrawals/sweep`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ toAddress: ZeroAddress }),
        });
        expect(badZero.status).toBe(400);

        const missingKey = await fetch(`${baseUrl}/withdrawals/sweep`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ toAddress: DESTINATION, broadcast: true }),
        });
        expect(missingKey.status).toBe(400);

        const planRes = await fetch(`${baseUrl}/withdrawals/sweep`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ toAddress: DESTINATION, walletIndices: [0] }),
        });
        expect(planRes.status).toBe(200);
        const planBody = (await planRes.json()) as {
          broadcast: boolean;
          summary: { stepsReady: number };
        };
        expect(planBody.broadcast).toBe(false);
        expect(planBody.summary.stepsReady).toBe(1);
        expect(broadcastTransaction).not.toHaveBeenCalled();

        const sendHeaders = { ...auth, "idempotency-key": "sweep-1" };
        const sendBody = JSON.stringify({
          toAddress: DESTINATION,
          walletIndices: [0],
          broadcast: true,
        });

        const sendRes = await fetch(`${baseUrl}/withdrawals/sweep`, {
          method: "POST",
          headers: sendHeaders,
          body: sendBody,
        });
        expect(sendRes.status).toBe(201);
        expect(broadcastTransaction).toHaveBeenCalledTimes(1);

        const replayRes = await fetch(`${baseUrl}/withdrawals/sweep`, {
          method: "POST",
          headers: sendHeaders,
          body: sendBody,
        });
        expect(replayRes.status).toBe(201);
        expect(((await replayRes.json()) as { idempotentReplay?: boolean }).idempotentReplay).toBe(
          true,
        );
        expect(broadcastTransaction).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("returns 400 on invalid sweep parameter combinations", async () => {
    await withSweepServer(
      {},
      {},
      async ({ baseUrl }) => {
        const post = async (body: unknown) => {
          const res = await fetch(`${baseUrl}/withdrawals/sweep`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          return { status: res.status, json: (await res.json()) as { error: string } };
        };

        expect((await post({ toAddress: DESTINATION, unwrap: true })).status).toBe(400);
        expect(
          (await post({ toAddress: DESTINATION, includeNative: false, tokens: [] })).status,
        ).toBe(400);
        expect(
          (await post({ toAddress: DESTINATION, walletIndices: [99] })).status,
        ).toBe(400);
        expect(
          (await post({ toAddress: getAddress(DESTINATION), tokens: ["not-addr"] })).status,
        ).toBe(400);
      },
    );
  });
});

describe("wallet:sweep CLI script", () => {
  it("runs plan mode via CLI against an RPC node and writes --out report", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sweep-cli-"));
    tempDirs.push(dir);
    const outFile = path.join(dir, "plan.json");
    const sentRaw: string[] = [];

    const rpcServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const calls = Array.isArray(payload) ? payload : [payload];
        const answers = calls.map((c: { id: number; method: string; params?: unknown[] }) => {
          let result: unknown = "0x0";
          if (c.method === "eth_chainId") result = "0xaa36a7";
          else if (c.method === "eth_blockNumber") result = "0x10";
          else if (c.method === "eth_getBalance") {
            const addr = String(c.params?.[0] ?? "").toLowerCase();
            result = addr === W0.toLowerCase() ? "0x06f05b59d3b20000" : "0x0"; // 0.5 ETH
          } else if (c.method === "eth_getTransactionCount") result = "0x0";
          else if (c.method === "eth_gasPrice") result = "0x77359400"; // 2 gwei
          else if (c.method === "eth_maxPriorityFeePerGas") result = "0x3b9aca00"; // 1 gwei
          else if (c.method === "eth_getBlockByNumber") {
            result = {
              number: "0x10",
              hash: "0x" + "11".repeat(32),
              parentHash: "0x" + "00".repeat(32),
              timestamp: "0x67000000",
              nonce: "0x0000000000000000",
              difficulty: "0x0",
              gasLimit: "0x1c9c380",
              gasUsed: "0x0",
              miner: ZeroAddress,
              extraData: "0x",
              baseFeePerGas: "0x3b9aca00",
              transactions: [],
            };
          } else if (c.method === "eth_feeHistory") {
            result = {
              oldestBlock: "0xf",
              baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
              gasUsedRatio: [0.5],
              reward: [["0x3b9aca00"]],
            };
          } else if (c.method === "eth_sendRawTransaction") {
            const raw = String(c.params?.[0] ?? "");
            sentRaw.push(raw);
            result = Transaction.from(raw).hash;
          }
          return { jsonrpc: "2.0", id: c.id, result };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(payload) ? answers : answers[0]));
      });
    });

    await new Promise<void>((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
    const rpcUrl = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`;

    try {
      const exec = promisify(execFile);
      const { stdout } = await exec(
        process.execPath,
        [
          "node_modules/.bin/tsx",
          "scripts/sweep-wallets.ts",
          "--to",
          DESTINATION,
          "--index",
          "0,2",
          "--eth-only",
          "--out",
          outFile,
        ],
        {
          env: {
            ...process.env,
            SEPOLIA_RPC_URL: rpcUrl,
            WALLET_MNEMONIC: TEST_MNEMONIC,
            WALLET_COUNT: "5",
            DATABASE_PATH: ":memory:",
            OWNER_ADDRESS: undefined,
            API_TOKENS: undefined,
            WITHDRAWAL_ALLOWLIST: undefined,
          },
        },
      );

      expect(stdout).toMatch(/Wallet sweep \(planned\)/);
      expect(stdout).toMatch(/Nothing was sent\. Add --broadcast/);
      const written = JSON.parse(fs.readFileSync(outFile, "utf8")) as {
        broadcast: boolean;
        summary: { walletsScanned: number; stepsReady: number; stepsSkipped: number };
      };
      expect(written.broadcast).toBe(false);
      expect(written.summary).toMatchObject({
        walletsScanned: 2,
        stepsReady: 1,
        stepsSkipped: 1,
      });
      expect(sentRaw).toHaveLength(0);

      const { stdout: sentOut } = await exec(
        process.execPath,
        [
          "node_modules/.bin/tsx",
          "scripts/sweep-wallets.ts",
          "--to",
          DESTINATION,
          "--index",
          "0",
          "--eth-only",
          "--broadcast",
        ],
        {
          env: {
            ...process.env,
            SEPOLIA_RPC_URL: rpcUrl,
            WALLET_MNEMONIC: TEST_MNEMONIC,
            WALLET_COUNT: "5",
            DATABASE_PATH: ":memory:",
            OWNER_ADDRESS: undefined,
            API_TOKENS: undefined,
            WITHDRAWAL_ALLOWLIST: undefined,
          },
        },
      );
      expect(sentOut).toMatch(/Wallet sweep on sepolia/);
      expect(sentRaw).toHaveLength(1);
      expect(Transaction.from(sentRaw[0]!).to).toBe(DESTINATION);
    } finally {
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
    }
  });
});
