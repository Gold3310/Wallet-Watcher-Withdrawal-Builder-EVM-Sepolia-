import type { AddressInfo } from "node:net";
import { getAddress, parseEther, parseUnits } from "ethers";
import type { FunctionFragment } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { withConfig } from "./helpers/withConfig.js";
import {
  HUB_POOL_IMMUTABLE,
  hubPoolInterface,
  trackedContractInterface,
  TRANSFER_RESTRICTION,
} from "../src/domain/assets/abi.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const OWNER = "0x2ddfbeca5b62f310a5f8edefb4fc026a99b979ce";
const OWNER_CHECKSUMMED = getAddress(OWNER);
const HUB_POOL = HUB_POOL_IMMUTABLE;
const OTHER_TOKEN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX_HASH = "0x" + "ab".repeat(32);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x" + "00".repeat(32);

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
  /** ETH balance per lowercase address — wallet funds and contract reserves. */
  ethBalances?: Record<string, bigint>;
  balances?: Record<string, bigint>;
  decimals?: Record<string, number>;
  symbols?: Record<string, string>;
  names?: Record<string, string>;
  totalSupply?: Record<string, bigint>;
  owner?: Record<string, string>;
  hubPool?: Record<string, string>;
  /** Lowercase addresses allowed to transfer, per lowercase contract. */
  proposers?: Record<string, string[]>;
  /** Pending root-bundle proposer, per lowercase hubPool address. */
  rootBundleProposer?: Record<string, string>;
  /** Calls to make revert, keyed by lowercase contract address. */
  failing?: Record<string, string[]>;
  broadcast?: ReturnType<typeof vi.fn>;
}

const enc = (name: string, values: unknown[]) =>
  trackedContractInterface.encodeFunctionResult(name, values as never[]);

function mockProvider(options: MockOptions = {}) {
  return {
    getBalance: vi.fn().mockImplementation(
      (address: string) =>
        Promise.resolve(
          options.ethBalances?.[address.toLowerCase()] ??
            options.nativeWei ??
            parseEther("2"),
        ) as Promise<bigint>,
    ),
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
      const name =
        trackedContractInterface.getFunction(data.slice(0, 10))?.name ??
        hubPoolInterface.getFunction(data.slice(0, 10))?.name;

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
        case "rootBundleProposal": {
          const proposer = options.rootBundleProposer?.[key] ?? ZERO_ADDRESS;
          return hubPoolInterface.encodeFunctionResult("rootBundleProposal", [
            [
              ZERO_BYTES32,
              ZERO_BYTES32,
              ZERO_BYTES32,
              0n,
              proposer,
              0,
              0,
            ],
          ]);
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

  it("states the gate as destination-scoped", () => {
    expect(TRANSFER_RESTRICTION).toMatch(/except to the hubPool/);
  });
});

describe("destination-scoped transfer gate", () => {
  const HOLDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // wallet 0 of the test mnemonic

  it("allows an approved proposer to send to the hubPool", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransferToRestrictedDestination).toBe(true);
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        proposers: { [CONTRACT.toLowerCase()]: [HOLDER.toLowerCase()] },
      },
    );
  });

  it("allows an unapproved holder who is not the pending proposer", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        // Someone else is the pending proposer, so the gate does not bite.
        expect(wallet!.tokens[0]!.canTransferToRestrictedDestination).toBe(true);
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        rootBundleProposer: { [HUB_POOL.toLowerCase()]: ZERO_ADDRESS },
      },
    );
  });

  it("blocks only while you are the pending proposer and unapproved", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransferToRestrictedDestination).toBe(false);
        // The balance is still reported: it is only the hubPool that is closed.
        expect(wallet!.tokens[0]!.balanceFormatted).toBe("5.0");
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        rootBundleProposer: { [HUB_POOL.toLowerCase()]: HOLDER },
      },
    );
  });

  it("leaves the answer unknown when the proposer list cannot be read", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransferToRestrictedDestination).toBeNull();
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        failing: { [CONTRACT.toLowerCase()]: ["proposers"] },
      },
    );
  });

  it("leaves the answer unknown when the pending proposer cannot be read", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransferToRestrictedDestination).toBeNull();
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        failing: { [HUB_POOL.toLowerCase()]: ["rootBundleProposal"] },
      },
    );
  });

  it("reports no gate at all when the contract has no hubPool", async () => {
    await withTracked(
      { TRACKED_CONTRACT: OTHER_TOKEN },
      async ({ assets }) => {
        const [info] = await assets.getTrackedContractInfo();
        expect(info!.restrictedDestination).toBeNull();

        const [wallet] = await assets.getAllWalletAssets();
        expect(wallet!.tokens[0]!.canTransferToRestrictedDestination).toBe(true);
      },
      {
        balances: { [OTHER_TOKEN.toLowerCase()]: parseUnits("5", 18) },
        failing: { [OTHER_TOKEN.toLowerCase()]: ["hubPool"] },
      },
    );
  });

  it("reports the gate on the contract, and only for the hubPool", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [info] = await assets.getTrackedContractInfo();

        expect(info!.hubPool).toBe(HUB_POOL);
        expect(info!.restrictedDestination).toBe(HUB_POOL);
        expect(info!.restriction).toBe(TRANSFER_RESTRICTION);
        expect(info!.restriction).toMatch(/except to the hubPool/);
        expect(info!.owner).toBe(OWNER_CHECKSUMMED);
        expect(info!.unwrapFunction).toBe("withdraw");
        expect(info!.totalSupplyFormatted).toBe("1000.0");
        expect(info!.symbol).toBe("WETH");
      },
      { totalSupply: { [CONTRACT.toLowerCase()]: parseUnits("1000", 18) } },
    );
  });

  it("reports the ETH backing the supply, and whether it covers it", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [info] = await assets.getTrackedContractInfo();

        // totalSupply() is defined as address(this).balance, so for a
        // WETH-style token this is exactly the redemption backing.
        expect(info!.totalSupplyFormatted).toBe("42.591");
        expect(info!.ethReserveFormatted).toBe("42.591");
        expect(info!.fullyBacked).toBe(true);
      },
      {
        totalSupply: { [CONTRACT.toLowerCase()]: parseUnits("42.591", 18) },
        ethBalances: { [CONTRACT.toLowerCase()]: parseUnits("42.591", 18) },
      },
    );
  });

  it("flags a supply that is not fully backed", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ assets }) => {
        const [info] = await assets.getTrackedContractInfo();
        expect(info!.fullyBacked).toBe(false);
      },
      {
        totalSupply: { [CONTRACT.toLowerCase()]: parseUnits("100", 18) },
        ethBalances: { [CONTRACT.toLowerCase()]: parseUnits("42.591", 18) },
      },
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

  it("refuses to unwrap more ETH than the contract actually holds", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ unwrap }) => {
        // The wallet holds 5 ABT, but the contract only holds 1 ETH of backing.
        await expect(
          unwrap.buildUnwrapTransaction({
            fromWalletIndex: 0,
            amountWei: parseUnits("2", 18).toString(),
            broadcast: false,
          }),
        ).rejects.toThrow(/not fully backed/);
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        ethBalances: { [CONTRACT.toLowerCase()]: parseUnits("1", 18) },
      },
    );
  });

  it("unwraps up to the ETH the contract holds", async () => {
    await withTracked(
      { TRACKED_CONTRACT: CONTRACT },
      async ({ unwrap }) => {
        const built = await unwrap.buildUnwrapTransaction({
          fromWalletIndex: 0,
          amountWei: parseUnits("2", 18).toString(),
          broadcast: false,
        });
        expect(built.amountWei).toBe(parseUnits("2", 18).toString());
      },
      {
        balances: { [CONTRACT.toLowerCase()]: parseUnits("5", 18) },
        ethBalances: { [CONTRACT.toLowerCase()]: parseUnits("42.591", 18) },
      },
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
