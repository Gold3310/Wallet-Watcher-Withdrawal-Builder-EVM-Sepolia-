import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEther } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withConfig } from "./helpers/withConfig.js";

const DESTINATION = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const SEPOLIA_ENV = {
  CHAIN: undefined,
  MAINNET_ENABLED: undefined,
  MAINNET_RPC_URL: undefined,
  MAINNET_MAX_TX_VALUE_WEI: undefined,
  MAINNET_ALLOW_UNBOUNDED_GRANTS: undefined,
  MAINNET_MAX_GRANT_EXPIRY_SECONDS: undefined,
  WALLET_MNEMONIC: TEST_MNEMONIC,
  WALLET_COUNT: "5",
  SEPOLIA_RPC_URL: "https://sepolia.example",
  DATABASE_PATH: ":memory:",
};

const MAINNET_ENV = {
  ...SEPOLIA_ENV,
  CHAIN: "mainnet",
  MAINNET_ENABLED: "true",
  MAINNET_RPC_URL: "https://mainnet.example",
  // Required: mainnet refuses to boot with an unauthenticated API.
  API_TOKENS: "0x2ddFBecA5B62f310A5F8edEFB4fC026A99B979CE:test-token",
};

function mockProvider() {
  return {
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getBalance: vi.fn().mockResolvedValue(parseEther("1000")),
    broadcastTransaction: vi.fn(),
  };
}

const tempDirs: string[] = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wallet-watcher-"));
  tempDirs.push(dir);
  return path.join(dir, "wallets.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("network configuration", () => {
  it("defaults to Sepolia with no mainnet guardrails", async () => {
    await withConfig(SEPOLIA_ENV, (config) => {
      expect(config.network).toBe("sepolia");
      expect(config.chainId).toBe(11155111);
      expect(config.isTestnet).toBe(true);
      expect(config.maxTxValueWei).toBeNull();
      expect(config.allowUnboundedGrants).toBe(true);
      expect(config.databasePath).toBe(":memory:");
    });
  });

  it("refuses to start on mainnet without an explicit opt-in", async () => {
    await expect(
      withConfig({ ...MAINNET_ENV, MAINNET_ENABLED: undefined }, () => null),
    ).rejects.toThrow("Refusing to start on mainnet");
  });

  it("runs on mainnet once opted in, with the default guardrails", async () => {
    await withConfig(MAINNET_ENV, (config) => {
      expect(config.network).toBe("mainnet");
      expect(config.chainId).toBe(1);
      expect(config.isTestnet).toBe(false);
      expect(config.maxTxValueWei).toBe(parseEther("0.1"));
      expect(config.permissionsMaxExpirySeconds).toBe(24 * 60 * 60);
      expect(config.allowUnboundedGrants).toBe(false);
    });
  });

  it("isolates the mainnet database by default", async () => {
    await withConfig(
      { ...MAINNET_ENV, DATABASE_PATH: undefined },
      (config) => {
        expect(config.databasePath).toBe("./data/mainnet-wallets.db");
      },
    );
  });

  it("refuses to expose an unauthenticated API on mainnet", async () => {
    await expect(
      withConfig({ ...MAINNET_ENV, API_TOKENS: undefined }, () => null),
    ).rejects.toThrow("Refusing to start on mainnet without API_TOKENS");
  });

  it("rejects an unknown chain", async () => {
    await expect(
      withConfig({ ...SEPOLIA_ENV, CHAIN: "ethereum" }, () => null),
    ).rejects.toThrow("CHAIN must be one of: sepolia, mainnet");
  });

  it("rejects a malformed mainnet value cap", async () => {
    await expect(
      withConfig(
        { ...MAINNET_ENV, MAINNET_MAX_TX_VALUE_WEI: "0.5" },
        () => null,
      ),
    ).rejects.toThrow("must be a valid unsigned integer string of wei");
  });
});

describe("mainnet guardrails", () => {
  it("caps the value of a single mainnet transaction", async () => {
    await withConfig(MAINNET_ENV, async (config) => {
      const { initializeWallets } = await import(
        "../src/domain/balance/balance.service.js"
      );
      const { buildWithdrawalTransaction } = await import(
        "../src/domain/withdrawal/withdrawal.service.js"
      );
      const { setProvider } = await import("../src/infra/rpc/provider.js");
      const database = await import("../src/infra/db/database.js");

      initializeWallets();
      setProvider(mockProvider() as never);

      await expect(
        buildWithdrawalTransaction({
          fromWalletIndex: 0,
          toAddress: DESTINATION,
          amountWei: parseEther("1").toString(),
          broadcast: false,
        }),
      ).rejects.toThrow("exceeds the mainnet per-transaction limit");

      const withinLimit = await buildWithdrawalTransaction({
        fromWalletIndex: 0,
        toAddress: DESTINATION,
        amountWei: parseEther("0.05").toString(),
        broadcast: false,
      });

      expect(BigInt(withinLimit.value)).toBe(parseEther("0.05"));
      expect(withinLimit.chainId).toBe(config.chainId);

      database.closeDatabase();
    });
  });

  it("leaves testnets uncapped", async () => {
    await withConfig(SEPOLIA_ENV, async () => {
      const { initializeWallets } = await import(
        "../src/domain/balance/balance.service.js"
      );
      const { buildWithdrawalTransaction } = await import(
        "../src/domain/withdrawal/withdrawal.service.js"
      );
      const { setProvider } = await import("../src/infra/rpc/provider.js");
      const database = await import("../src/infra/db/database.js");

      initializeWallets();
      setProvider(mockProvider() as never);

      const built = await buildWithdrawalTransaction({
        fromWalletIndex: 0,
        toAddress: DESTINATION,
        amountWei: parseEther("10").toString(),
        broadcast: false,
      });

      expect(BigInt(built.value)).toBe(parseEther("10"));
      database.closeDatabase();
    });
  });

  it("requires a spending cap on mainnet grants", async () => {
    await withConfig(MAINNET_ENV, async () => {
      const { initializeWallets } = await import(
        "../src/domain/balance/balance.service.js"
      );
      const { grantPermissions } = await import(
        "../src/domain/permissions/permission.service.js"
      );
      const database = await import("../src/infra/db/database.js");

      initializeWallets();

      expect(() =>
        grantPermissions({
          fromWalletIndex: 0,
          expiry: 3600,
          permissions: [{ type: "native-token-transfer", data: {}, policies: [] }],
        }),
      ).toThrow("must declare a 'spending-cap' policy");

      database.closeDatabase();
    });
  });

  it("allows unbounded mainnet grants when explicitly relaxed", async () => {
    await withConfig(
      { ...MAINNET_ENV, MAINNET_ALLOW_UNBOUNDED_GRANTS: "true" },
      async () => {
        const { initializeWallets } = await import(
          "../src/domain/balance/balance.service.js"
        );
        const { grantPermissions } = await import(
          "../src/domain/permissions/permission.service.js"
        );
        const database = await import("../src/infra/db/database.js");

        initializeWallets();

        const { session } = grantPermissions({
          fromWalletIndex: 0,
          expiry: 3600,
          permissions: [
            { type: "native-token-transfer", data: {}, policies: [] },
          ],
        });

        expect(session.status).toBe("active");
        expect(session.remainingWei).toBeNull();
        database.closeDatabase();
      },
    );
  });

  it("caps mainnet grant duration at 24h by default", async () => {
    await withConfig(MAINNET_ENV, async () => {
      const { initializeWallets } = await import(
        "../src/domain/balance/balance.service.js"
      );
      const { grantPermissions } = await import(
        "../src/domain/permissions/permission.service.js"
      );
      const database = await import("../src/infra/db/database.js");

      initializeWallets();

      expect(() =>
        grantPermissions({
          fromWalletIndex: 0,
          expiry: 30 * 24 * 60 * 60,
          permissions: [
            {
              type: "native-token-transfer",
              data: {},
              policies: [{ type: "spending-cap", data: { limit: "1000" } }],
            },
          ],
        }),
      ).toThrow("must not exceed 86400 seconds");

      database.closeDatabase();
    });
  });
});

describe("database network binding", () => {
  it("refuses to reuse a database on a different chain", async () => {
    const databasePath = tempDatabasePath();

    await withConfig(
      { ...SEPOLIA_ENV, DATABASE_PATH: databasePath },
      async () => {
        const database = await import("../src/infra/db/database.js");
        database.getDatabase();
        database.closeDatabase();
      },
    );

    await withConfig(
      { ...MAINNET_ENV, DATABASE_PATH: databasePath },
      async () => {
        const database = await import("../src/infra/db/database.js");
        expect(() => database.getDatabase()).toThrow(
          "belongs to network 'sepolia'",
        );
        database.closeDatabase();
      },
    );
  });
});
