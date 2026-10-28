import type { AddressInfo } from "node:net";
import { getAddress, parseEther, parseUnits } from "ethers";
import type { FunctionFragment } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { withConfig } from "./helpers/withConfig.js";
import {
  HUB_POOL_IMMUTABLE,
  TRANSFERS_RESTRICTED,
  trackedContractInterface,
} from "../src/domain/assets/abi.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const OWNER = "0x2ddfbeca5b62f310a5f8edefb4fc026a99b979ce";
const OWNER_CHECKSUMMED = getAddress(OWNER);
const HUB_POOL = HUB_POOL_IMMUTABLE;
const OTHER_TOKEN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX_HASH = "0x" + "ab".repeat(32);

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const BASE_ENV: Record<string, string | undefined> = {
  CHAIN: undefined,
  MAINNET_ENABLED: undefined,
  WALLET_MNEMONIC: TEST_MNEMONIC,
  WALLET_COUNT: "3",
  SEPOLIA_RPC_URL: "https://sepolia.example",
  DATABASE_PATH: ":memory:",
  API_TOKENS: undefined,
  OWNER_ADDRESS: undefined,
  TRACKED_CONTRACT: undefined,
  TRACKED_TOKENS: undefined,
};

interface MockOptions {
  nativeWei?: bigint;
  balances?: Record<string, bigint>;
  decimals?: Record<string, number>;
  symbols?: Record<string, string>;
  names?: Record<string, string>;
  totalSupply?: Record<string, bigint>;
  owner?: Record<string, string>;
  hubPool?: Record<string, string>;
  /** Lowercase addresses allowed to transfer, per lowercase contract. */
  proposers?: Record<string, string[]>;
  /** Calls to make revert, keyed by lowercase contract address. */
  failing?: Record<string, string[]>;
  broadcast?: ReturnType<typeof vi.fn>;
}

const enc = (name: string, values: unknown[]) =>
  trackedContractInterface.encodeFunctionResult(name, values as never[]);

function mockProvider(options: MockOptions = {}) {
  return {
    getBalance: vi.fn().mockResolvedValue(options.nativeWei ?? parseEther("2")),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    estimateGas: vi.fn().mockResolvedValue(60_000n),
    broadcastTransaction:
      options.broadcast ?? vi.fn().mockResolvedValue({ hash: TX_HASH }),
    call: vi.fn(async ({ to, data }: { to: string; data: string }) => {
      const key = to.toLowerCase();
      const name = trackedContractInterface.getFunction(data.slice(0, 10))?.name;

      if (options.failing?.[key]?.includes(name ?? "")) {
        throw new Error(`${name} reverted`);
      }

      switch (name) {
        case "balanceOf":
          return enc("balanceOf", [options.balances?.[key] ?? 0n]);
        case "decimals":
          return enc("decimals", [options.decimals?.[key] ?? 18]);
        case "symbol":
          return enc("symbol", [options.symbols?.[key] ?? "WETH"]);
        case "name":
          return enc("name", [options.names?.[key] ?? "Wrapped Ether"]);
        case "totalSupply":
          return enc("totalSupply", [options.totalSupply?.[key] ?? 0n]);
        case "owner":
          return enc("owner", [options.owner?.[key] ?? OWNER]);
        case "hubPool":
          return enc("hubPool", [options.hubPool?.[key] ?? HUB_POOL]);
        case "proposers": {
          const [holder] = trackedContractInterface.decodeFunctionData(
            "proposers",
            data,
          );
          const allowed = options.proposers?.[key] ?? [];
          return enc("proposers", [allowed.includes(String(holder).toLowerCase())]);
        }
        default:
          throw new Error(`unexpected call: ${name}`);
      }
    }),
  };
}

async function withTracked<T>(
  env: Record<string, string | undefined>,
  fn: (ctx: {
    provider: ReturnType<typeof mockProvider>;
    assets: typeof import("../src/domain/assets/asset.service.js");
    unwrap: typeof import("../src/domain/assets/unwrap.service.js");
  }) => Promise<T>,
  options: MockOptions = {},
): Promise<T> {
  return withConfig({ ...BASE_ENV, ...env }, async () => {
    const { initializeWallets } = await import(
      "../src/domain/balance/balance.service.js"
    );
    const { setProvider } = await import("../src/infra/rpc/provider.js");
    const { resetNonce } = await import("../src/domain/wallet/nonce.manager.js");
    const database = await import("../src/infra/db/database.js");
    const assets = await import("../src/domain/assets/asset.service.js");
    const unwrap = await import("../src/domain/assets/unwrap.service.js");

    const provider = mockProvider(options);
    initializeWallets();
    setProvider(provider as never);
    resetNonce();

    try {
      return await fn({ provider, assets, unwrap });
    } finally {
      database.closeDatabase();
    }
  });
}

describe("tracked contract ABI", () => {
  it("covers every function the deployed bytecode dispatches", () => {
    const names = trackedContractInterface.fragments
      .filter(
        (fragment): fragment is FunctionFragment =>
          fragment.type === "function",
      )
      .map((fragment) => fragment.name)
      .sort();

    expect(names).toEqual(
      [
        "allowance",
        "approve",
        "balanceOf",
        "decimals",
        "deposit",
        "hubPool",
        "name",
        "owner",
        "proposers",
        "renounceOwnership",
        "setProposer",
        "symbol",
        "totalSupply",
        "transfer",
        "transferFrom",
        "transferOwnership",
        "withdraw",
      ].sort(),
    );
  });

  it("encodes withdraw with the selector the bytecode dispatches", () => {
    const data = trackedContractInterface.encodeFunctionData("withdraw", [
      parseUnits("1", 18),
    ]);

    expect(data.slice(0, 10)).toBe("0x2e1a7d4d");
    expect(trackedContractInterface.getFunction("withdraw")!.selector).toBe(
      "0x2e1a7d4d",
    );
  });

  it("marks transfers as restricted", () => {
    expect(TRANSFERS_RESTRICTED).toBe(true);
  });
});

describe("restricted transfer reporting", () => {
  const HOLDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // wallet 0 of the test mnemonic

  it("reports canTransfer true for an approved proposer", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransfer).toBe(true);
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        proposers: { [CONTRACT.toLowerCase()]: [HOLDER.toLowerCase()] },
      },
    );
  });

  it("reports canTransfer false for a holder that is not a proposer", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransfer).toBe(false);
        // The balance is still reported: you own it, you just cannot move it.
        expect(wallet!.tokens[0]!.balanceFormatted).toBe("5.0");
      },
      { balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) } },
    );
  });

  it("treats the hubPool itself as always able to transfer", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const info = await assets.getTrackedContractInfo();
        expect(info[0]!.hubPool).toBe(HUB_POOL);

        const asset = await assets.readTokenAsset(
          {
            call: async ({ data }) => {
              const name = trackedContractInterface.getFunction(
                data.slice(0, 10),
              )?.name;
              if (name === "proposers") {
                return enc("proposers", [false]);
              }
              if (name === "hubPool") {
                return enc("hubPool", [HUB_POOL]);
              }
              return enc("balanceOf", [parseUnits("1", 18)]);
            },
            getBalance: async () => 0n,
          },
          CONTRACT,
          HUB_POOL,
        );

        expect(asset.canTransfer).toBe(true);
      },
      {},
    );
  });

  it("leaves canTransfer unknown when the contract has no proposer list", async () => {
    await withTracked(
      { TRACKED_CONTRACT: OTHER_TOKEN },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransfer).toBeNull();
      },
      {
        balances: { [OTHER_TOKEN.toLowerCase()]: parseUnits("5", 18) },
        failing: { [OTHER_TOKEN.toLowerCase()]: ["proposers"] },
      },
    );
  });

  it("reports the contract's own owner and hubPool separately from balances", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [info] = await assets.getTrackedContractInfo();

        expect(info!.owner).toBe(OWNER_CHECKSUMMED);
        expect(info!.hubPool).toBe(HUB_POOL);
        expect(info!.transfersRestricted).toBe(true);
        expect(info!.unwrapFunction).toBe("withdraw");
        expect(info!.totalSupplyFormatted).toBe("1000.0");
        expect(info!.symbol).toBe("WETH");
      },
      { totalSupply: { [CONTRACT.toLowerCase()]: parseUnits("1000", 18) } },
    );
  });
});

describe("unwrapping a restricted balance", () => {
  it("builds a withdraw call for exactly the requested amount", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ unwrap }) => {
        const built = await unwrap.buildUnwrapTransaction({
          fromWalletIndex: 0,
          amountWei: parseUnits("2", 18).toString(),
          broadcast: false,
        });

        expect(built.contract).toBe(CONTRACT);
        expect(built.data.slice(0, 10)).toBe("0x2e1a7d4d");
        expect(built.amountWei).toBe(parseUnits("2", 18).toString());
        // withdraw() credits the caller with the same amount, as ETH.
        expect(built.ethWei).toBe(built.amountWei);
        expect(built.function).toBe("withdraw(uint256)");
        expect(built.serialized).toMatch(/^0x02/);
      },
      { balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) } },
    );
  });

  it("sends nothing unless broadcast is requested", async () => {
    const broadcast = vi.fn().mockResolvedValue({ hash: TX_HASH });

    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ unwrap }) => {
        const result = await unwrap.createUnwrap({
          fromWalletIndex: 0,
          amountWei: parseUnits("1", 18).toString(),
          broadcast: false,
        });

        expect(result.broadcast).toBe(false);
        expect(result.txHash).toBeUndefined();
        expect(broadcast).not.toHaveBeenCalled();
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        broadcast,
      },
    );
  });

  it("broadcasts and returns the hash when asked", async () => {
    const broadcast = vi.fn().mockResolvedValue({ hash: TX_HASH });

    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ unwrap }) => {
        const result = await unwrap.createUnwrap({
          fromWalletIndex: 0,
          amountWei: parseUnits("1", 18).toString(),
          broadcast: true,
        });

        expect(result.broadcast).toBe(true);
        expect(result.txHash).toBe(TX_HASH);
        expect(broadcast).toHaveBeenCalledTimes(1);
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        broadcast,
      },
    );
  });

  it("refuses to unwrap more than the wallet holds", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ unwrap }) => {
        await expect(
          unwrap.buildUnwrapTransaction({
            fromWalletIndex: 0,
            amountWei: parseUnits("50", 18).toString(),
            broadcast: false,
          }),
        ).rejects.toThrow(/Insufficient wrapped balance/);
      },
      { balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) } },
    );
  });

  it("refuses when no contract is tracked", async () => {
    await withTracked({}, async ({ unwrap }) => {
      await expect(
        unwrap.buildUnwrapTransaction({
          fromWalletIndex: 0,
          amountWei: "1",
          broadcast: false,
        }),
      ).rejects.toThrow(/No contract is tracked/);
    });
  });

  it("refuses to guess which contract to unwrap when several are tracked", async () => {
    await withTracked(
      { TRACKED_CONTRACT: `${CONTRACT},${OTHER_TOKEN}` },
      async ({ unwrap }) => {
        await expect(
          unwrap.buildUnwrapTransaction({
            fromWalletIndex: 0,
            amountWei: "1",
            broadcast: false,
          }),
        ).rejects.toThrow(/exactly one tracked contract/);
      },
    );
  });

  it("rejects a wallet index that does not exist", async () => {
    await withTracked({ TRACKED_CONTRACT: CONTRACT }, async ({ unwrap }) => {
      await expect(
        unwrap.buildUnwrapTransaction({
          fromWalletIndex: 99,
          amountWei: "1",
          broadcast: false,
        }),
      ).rejects.toThrow(/does not exist/);
    });
  });

  it("exposes unwrapping over HTTP", async () => {
    const broadcast = vi.fn().mockResolvedValue({ hash: TX_HASH });

    await withConfig(
      { ...BASE_ENV, TRACKED_CONTRACT: CONTRACT },
      async () => {
        const { createApp } = await import("../src/api/app.js");
        const { initializeWallets } = await import(
          "../src/domain/balance/balance.service.js"
        );
        const { setProvider } = await import("../src/infra/rpc/provider.js");
        const database = await import("../src/infra/db/database.js");

        initializeWallets();
        setProvider(
          mockProvider({
            balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
            broadcast,
          }) as never,
        );

        const app = createApp();
        const server = await new Promise<import("node:http").Server>(
          (resolve) => {
            const started = app.listen(0, () => resolve(started));
          },
        );
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        try {
          const built = await fetch(`${baseUrl}/assets/unwrap`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              fromWalletIndex: 0,
              amountWei: parseUnits("1", 18).toString(),
              broadcast: false,
            }),
          });

          expect(built.status).toBe(200);
          const body = await built.json();
          expect(body.broadcast).toBe(false);
          expect(body.transaction.data.slice(0, 10)).toBe("0x2e1a7d4d");
          expect(broadcast).not.toHaveBeenCalled();

          const over = await fetch(`${baseUrl}/assets/unwrap`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              fromWalletIndex: 0,
              amountWei: parseUnits("99", 18).toString(),
              broadcast: false,
            }),
          });

          expect(over.status).toBe(400);
          expect((await over.json()).error).toMatch(/Insufficient wrapped balance/);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          database.closeDatabase();
        }
      },
    );
  });
});
