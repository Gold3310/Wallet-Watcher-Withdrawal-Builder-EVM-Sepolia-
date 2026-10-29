import { parseUnits } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { trackedContractInterface } from "../src/domain/assets/abi.js";
import type { HolderBalance } from "../src/domain/assets/holders.js";
import { withConfig } from "./helpers/withConfig.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const UMA = "0x54f44eA3D2e7aA0ac089c4d8F7C93C27844057BF";
const WALLET_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const SUPPLY = parseUnits("42.591", 18);
const RESERVE = parseUnits("42.591", 18);

const ENV: Record<string, string | undefined> = {
  CHAIN: undefined,
  MAINNET_ENABLED: undefined,
  WALLET_MNEMONIC: TEST_MNEMONIC,
  WALLET_COUNT: "2",
  SEPOLIA_RPC_URL: "https://sepolia.example",
  DATABASE_PATH: ":memory:",
  API_TOKENS: undefined,
  OWNER_ADDRESS: undefined,
  TRACKED_CONTRACT: CONTRACT,
  TRACKED_TOKENS: undefined,
};

const enc = (name: string, values: unknown[]) =>
  trackedContractInterface.encodeFunctionResult(name, values as never[]);

interface MockOptions {
  balances: Record<string, bigint>;
  natives: Record<string, bigint>;
  reserve: bigint;
  totalSupply: bigint;
}

function mockProvider(options: MockOptions) {
  return {
    getBalance: vi.fn(async (address: string) => {
      const key = address.toLowerCase();
      if (key === CONTRACT.toLowerCase()) {
        return options.reserve;
      }
      return options.natives[key] ?? 0n;
    }),
    call: vi.fn(async ({ to: _to, data }: { to: string; data: string }) => {
      const fragment = trackedContractInterface.getFunction(data.slice(0, 10));

      switch (fragment?.name) {
        case "balanceOf": {
          const [queried] = trackedContractInterface.decodeFunctionData(
            "balanceOf",
            data,
          ) as unknown as [string];
          return enc("balanceOf", [
            options.balances[queried.toLowerCase()] ?? 0n,
          ]);
        }
        case "decimals":
          return enc("decimals", [18]);
        case "symbol":
          return enc("symbol", ["ABT"]);
        case "totalSupply":
          return enc("totalSupply", [options.totalSupply]);
        default:
          throw new Error(`unexpected call: ${fragment?.name}`);
      }
    }),
  };
}

/** A HolderBalance-shaped row, enough for the classifier. */
function row(
  address: string,
  balance: bigint | null,
  signable = false,
): HolderBalance {
  return {
    label: address === CONTRACT ? "the contract" : address,
    address,
    balanceRaw: balance === null ? null : balance.toString(),
    balanceFormatted: balance === null ? null : balance.toString(),
    shareOfSupply: null,
    redeemableEth: null,
    canWithdrawNow: null,
    nativeWei: "0",
    nativeEth: "0.0",
    accessStatus: "unknown",
    signableByService: signable,
    error: null,
  };
}

async function load() {
  const [watcher, balance, db] = await Promise.all([
    import("../src/domain/assets/holder.watcher.js"),
    import("../src/domain/balance/balance.service.js"),
    import("../src/infra/db/database.js"),
  ]);
  return {
    classifyChange: watcher.classifyChange,
    pollHolderActivity: watcher.pollHolderActivity,
    initializeWallets: balance.initializeWallets,
    resetDatabase: db.resetDatabase,
    getHolderActivity: db.getHolderActivity,
  };
}

describe("classifying what happened", () => {
  it("records the first sighting of an address", async () => {
    await withConfig(ENV, async () => {
      const { classifyChange } = await load();
      expect(
        classifyChange(row(UMA, parseUnits("34.5", 18)), undefined, RESERVE, false)
          .changeType,
      ).toBe("initial");
    });
  });

  it("tells a redemption from a transfer", async () => {
    await withConfig(ENV, async () => {
      const { classifyChange } = await load();
      const previous = {
        balance_raw: parseUnits("34.5", 18).toString(),
        native_raw: "0",
        eth_reserve_raw: RESERVE.toString(),
      };

      // Balance fell AND the reserve fell: they burned it and took ETH.
      expect(
        classifyChange(
          row(UMA, parseUnits("30", 18)),
          previous,
          parseUnits("38.091", 18),
          false,
        ).changeType,
      ).toBe("holder-redeemed");

      // Balance fell, reserve unchanged: it moved house, nothing redeemed.
      expect(
        classifyChange(
          row(UMA, parseUnits("30", 18)),
          previous,
          RESERVE,
          false,
        ).changeType,
      ).toBe("holder-transferred");
    });
  });

  it("flags the token reaching an address it can sign for", async () => {
    await withConfig(ENV, async () => {
      const { classifyChange } = await load();
      const result = classifyChange(
        row(WALLET_0, parseUnits("1", 18), true),
        {
          balance_raw: "0",
          native_raw: "0",
          eth_reserve_raw: RESERVE.toString(),
        },
        RESERVE,
        false,
      );

      expect(result.changeType).toBe("arrived");
      expect(result.detail).toMatch(/changes what is possible/);
    });
  });

  it("reports reserve movement once, from the contract's own row", async () => {
    await withConfig(ENV, async () => {
      const { classifyChange } = await load();
      const previous = {
        balance_raw: "0",
        native_raw: "0",
        eth_reserve_raw: RESERVE.toString(),
      };
      const moved = parseUnits("40", 18);

      expect(
        classifyChange(row(CONTRACT, 0n), previous, moved, true).changeType,
      ).toBe("reserve-moved");

      // Every other row stays quiet, or the same alarm fires once per holder.
      expect(
        classifyChange(row(UMA, 0n), previous, moved, false).changeType,
      ).toBe("unchanged");
    });
  });

  it("says nothing happened when nothing did", async () => {
    await withConfig(ENV, async () => {
      const { classifyChange } = await load();
      expect(
        classifyChange(
          row(UMA, parseUnits("34.5", 18)),
          {
            balance_raw: parseUnits("34.5", 18).toString(),
            native_raw: "0",
            eth_reserve_raw: RESERVE.toString(),
          },
          RESERVE,
          false,
        ).changeType,
      ).toBe("unchanged");
    });
  });
});

describe("polling and recording", () => {
  const baseOptions: MockOptions = {
    balances: { [UMA.toLowerCase()]: parseUnits("34.5", 18) },
    natives: {},
    reserve: RESERVE,
    totalSupply: SUPPLY,
  };

  it("records each address on the first poll", async () => {
    await withConfig(ENV, async () => {
      const { pollHolderActivity, initializeWallets, resetDatabase } =
        await load();

      resetDatabase();
      initializeWallets();

      const changes = await pollHolderActivity(
        mockProvider(baseOptions) as never,
      );

      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((c) => c.changeType === "initial")).toBe(true);
    });
  });

  it("stays quiet when nothing moved", async () => {
    await withConfig(ENV, async () => {
      const { pollHolderActivity, initializeWallets, resetDatabase } =
        await load();

      resetDatabase();
      initializeWallets();
      const provider = mockProvider(baseOptions);

      await pollHolderActivity(provider as never);
      const second = await pollHolderActivity(provider as never);

      // History should read as things that happened, not a log of no-ops.
      expect(second).toHaveLength(0);
    });
  });

  it("notices a redemption and says which kind", async () => {
    await withConfig(ENV, async () => {
      const { pollHolderActivity, initializeWallets, resetDatabase } =
        await load();

      resetDatabase();
      initializeWallets();

      await pollHolderActivity(mockProvider(baseOptions) as never);

      // The holder's balance and the reserve both fall: redeemed.
      const changes = await pollHolderActivity(
        mockProvider({
          ...baseOptions,
          balances: { [UMA.toLowerCase()]: parseUnits("30", 18) },
          reserve: parseUnits("38.091", 18),
        }) as never,
      );

      const redemption = changes.find(
        (c) => c.address.toLowerCase() === UMA.toLowerCase(),
      );
      expect(redemption?.changeType).toBe("holder-redeemed");
    });
  });

  it("records the token arriving at a wallet it can sign for", async () => {
    await withConfig(ENV, async () => {
      const {
        pollHolderActivity,
        initializeWallets,
        resetDatabase,
        getHolderActivity,
      } = await load();

      resetDatabase();
      const wallets = initializeWallets();
      const mine = wallets[0].address;

      await pollHolderActivity(mockProvider(baseOptions) as never);

      const changes = await pollHolderActivity(
        mockProvider({
          ...baseOptions,
          balances: {
            [UMA.toLowerCase()]: parseUnits("34.5", 18),
            [mine.toLowerCase()]: parseUnits("2", 18),
          },
        }) as never,
      );

      const arrived = changes.find(
        (c) => c.address.toLowerCase() === mine.toLowerCase(),
      );

      expect(arrived?.changeType).toBe("arrived");
      expect(arrived?.signableByService).toBe(true);

      // And it is retrievable as history, newest first.
      const activity = getHolderActivity(50);
      expect(activity.some((a) => a.change_type === "arrived")).toBe(true);
    });
  });
});
