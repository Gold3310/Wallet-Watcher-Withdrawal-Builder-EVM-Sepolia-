import type { AddressInfo } from "node:net";
import { parseEther } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { withConfig } from "./helpers/withConfig.js";

const DESTINATION = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER_DESTINATION = "0x2EF4c86Bdd42884339643D2beCB32988D90A46F4";
/** Withdrawable owner: the destination withdrawals are permitted to target. */
const OWNER_ADDRESS = "0x2ddFBecA5B62f310A5F8edEFB4fC026A99B979CE";
const TX_HASH = "0x" + "33".repeat(32);
const TOKEN = "secret-123";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const BASE_ENV: Record<string, string | undefined> = {
  CHAIN: undefined,
  MAINNET_ENABLED: undefined,
  WALLET_MNEMONIC: TEST_MNEMONIC,
  WALLET_COUNT: "5",
  SEPOLIA_RPC_URL: "https://sepolia.example",
  DATABASE_PATH: ":memory:",
  API_TOKENS: undefined,
  WITHDRAWAL_ALLOWLIST: undefined,
  WITHDRAWAL_MAX_VALUE_WEI: undefined,
  WITHDRAWAL_MAX_PER_WINDOW_WEI: undefined,
  WITHDRAWAL_WINDOW_SECONDS: undefined,
};

interface Harness {
  baseUrl: string;
  broadcast: ReturnType<typeof vi.fn>;
}

function mockProvider(broadcast: ReturnType<typeof vi.fn>) {
  return {
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getBalance: vi.fn().mockResolvedValue(parseEther("1000")),
    broadcastTransaction: broadcast,
  };
}

/** Boots the HTTP app under a given environment, with a mocked provider. */
async function withServer(
  env: Record<string, string | undefined>,
  fn: (harness: Harness) => Promise<void>,
  options: { broadcast?: ReturnType<typeof vi.fn> } = {},
): Promise<void> {
  await withConfig({ ...BASE_ENV, ...env }, async () => {
    const { createApp } = await import("../src/api/app.js");
    const { initializeWallets } = await import(
      "../src/domain/balance/balance.service.js"
    );
    const { setProvider } = await import("../src/infra/rpc/provider.js");
    const database = await import("../src/infra/db/database.js");

    const broadcast =
      options.broadcast ?? vi.fn().mockResolvedValue({ hash: TX_HASH });

    setProvider(mockProvider(broadcast) as never);
    initializeWallets();

    const app = createApp();
    const server: import("node:http").Server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      await fn({ baseUrl, broadcast });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.closeDatabase();
    }
  });
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function authHeaders(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

const withdrawalBody = (overrides: Record<string, unknown> = {}) => ({
  fromWalletIndex: 0,
  toAddress: DESTINATION,
  amountWei: parseEther("0.01").toString(),
  broadcast: false,
  ...overrides,
});

describe("API authentication", () => {
  it("rejects unauthenticated requests when tokens are configured", async () => {
    await withServer({ API_TOKENS: `ops:${TOKEN}` }, async ({ baseUrl }) => {
      const anonymous = await fetch(`${baseUrl}/wallets`);
      expect(anonymous.status).toBe(401);
      expect((await anonymous.json()).error).toBe("Missing bearer token");

      const wrongToken = await fetch(`${baseUrl}/wallets`, {
        headers: { authorization: "Bearer not-the-token" },
      });
      expect(wrongToken.status).toBe(401);
      expect((await wrongToken.json()).error).toBe("Invalid API token");

      const authenticated = await fetch(`${baseUrl}/wallets`, {
        headers: authHeaders(),
      });
      expect(authenticated.status).toBe(200);
    });
  });

  it("leaves /health open for probes", async () => {
    await withServer({ API_TOKENS: `ops:${TOKEN}` }, async ({ baseUrl }) => {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
    });
  });

  it("runs open when no tokens are configured", async () => {
    await withServer({}, async ({ baseUrl }) => {
      const open = await fetch(`${baseUrl}/wallets`);
      expect(open.status).toBe(200);
    });
  });

  it("records which caller moved funds", async () => {
    await withServer({ API_TOKENS: `ops:${TOKEN}` }, async ({ baseUrl }) => {
      const response = await post(
        baseUrl,
        "/withdrawals",
        withdrawalBody({ broadcast: true }),
        authHeaders({ "idempotency-key": "attribution-1" }),
      );

      expect(response.status).toBe(201);
      expect(response.body.requestedBy).toBe("ops");

      const database = await import("../src/infra/db/database.js");
      const wallet = database.getWalletByIndex(0)!;
      const outflows = database
        .getLedgerForWallet(wallet.id)
        .filter((entry) => entry.type === "outflow");

      expect(outflows).toHaveLength(1);
      expect(outflows[0].actor).toBe("ops");
      expect(outflows[0].tx_hash).toBe(TX_HASH);
    });
  });
});

describe("concurrency", () => {
  it("cannot exceed a spending cap with concurrent redemptions", async () => {
    await withConfig(BASE_ENV, async () => {
      const { initializeWallets } = await import(
        "../src/domain/balance/balance.service.js"
      );
      const { grantPermissions, redeemPermission } = await import(
        "../src/domain/permissions/permission.service.js"
      );
      const { setProvider } = await import("../src/infra/rpc/provider.js");
      const database = await import("../src/infra/db/database.js");

      initializeWallets();
      setProvider(mockProvider(vi.fn().mockResolvedValue({ hash: TX_HASH })) as never);

      const { session } = grantPermissions({
        fromWalletIndex: 0,
        expiry: 600,
        permissions: [
          {
            type: "native-token-transfer",
            data: {},
            policies: [
              {
                type: "spending-cap",
                data: { limit: parseEther("0.05").toString() },
              },
            ],
          },
        ],
      });

      const results = await Promise.allSettled([
        redeemPermission({
          sessionId: session.id,
          toAddress: DESTINATION,
          amountWei: parseEther("0.04").toString(),
          broadcast: true,
        }),
        redeemPermission({
          sessionId: session.id,
          toAddress: DESTINATION,
          amountWei: parseEther("0.04").toString(),
          broadcast: true,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);

      const rejected = results.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      expect(String(rejected.reason)).toMatch(/exceeds the remaining spending cap/);

      const row = database
        .getDatabase()
        .prepare("SELECT spent_wei, nonce FROM permission_sessions WHERE id = ?")
        .get(session.id) as { spent_wei: string; nonce: number };

      // Only the winner is counted — previously this ended at 0.04 with both
      // transactions sent, i.e. 0.08 moved against a 0.05 cap.
      expect(row.spent_wei).toBe(parseEther("0.04").toString());
      expect(row.nonce).toBe(1);

      database.closeDatabase();
    });
  });

  it("gives concurrent withdrawals distinct nonces", async () => {
    await withConfig(BASE_ENV, async () => {
      const { initializeWallets } = await import(
        "../src/domain/balance/balance.service.js"
      );
      const { buildWithdrawalTransaction } = await import(
        "../src/domain/withdrawal/withdrawal.service.js"
      );
      const { setProvider } = await import("../src/infra/rpc/provider.js");
      const database = await import("../src/infra/db/database.js");

      initializeWallets();
      setProvider(mockProvider(vi.fn()) as never);

      const [a, b] = await Promise.all([
        buildWithdrawalTransaction({
          fromWalletIndex: 0,
          toAddress: DESTINATION,
          amountWei: parseEther("0.01").toString(),
          broadcast: false,
        }),
        buildWithdrawalTransaction({
          fromWalletIndex: 0,
          toAddress: DESTINATION,
          amountWei: parseEther("0.02").toString(),
          broadcast: false,
        }),
      ]);

      expect(Math.min(a.nonce, b.nonce)).toBe(0);
      expect(Math.max(a.nonce, b.nonce)).toBe(1);

      database.closeDatabase();
    });
  });

  it("hands the nonce back when a broadcast fails", async () => {
    await withConfig(BASE_ENV, async () => {
      const { initializeWallets } = await import(
        "../src/domain/balance/balance.service.js"
      );
      const { buildWithdrawalTransaction, createWithdrawal } = await import(
        "../src/domain/withdrawal/withdrawal.service.js"
      );
      const { setProvider } = await import("../src/infra/rpc/provider.js");
      const database = await import("../src/infra/db/database.js");

      initializeWallets();
      setProvider(
        mockProvider(vi.fn().mockRejectedValue(new Error("rpc down"))) as never,
      );

      await expect(
        createWithdrawal({
          fromWalletIndex: 0,
          toAddress: DESTINATION,
          amountWei: parseEther("0.01").toString(),
          broadcast: true,
        }),
      ).rejects.toThrow("rpc down");

      const retry = await buildWithdrawalTransaction({
        fromWalletIndex: 0,
        toAddress: DESTINATION,
        amountWei: parseEther("0.01").toString(),
        broadcast: false,
      });

      expect(retry.nonce).toBe(0);
      database.closeDatabase();
    });
  });
});

describe("idempotency", () => {
  it("replays the stored response instead of sending twice", async () => {
    await withServer({ API_TOKENS: `ops:${TOKEN}` }, async ({ baseUrl, broadcast }) => {
      const body = JSON.stringify(withdrawalBody({ broadcast: true }));
      const headers = authHeaders({
        "Content-Type": "application/json",
        "idempotency-key": "withdrawal-1",
      });

      const first = await fetch(`${baseUrl}/withdrawals`, {
        method: "POST",
        headers,
        body,
      });
      expect(first.status).toBe(201);
      const firstBody = await first.json();

      const second = await fetch(`${baseUrl}/withdrawals`, {
        method: "POST",
        headers,
        body,
      });
      expect(second.status).toBe(201);
      const secondBody = await second.json();

      expect(secondBody.idempotentReplay).toBe(true);
      expect(secondBody.txHash).toBe(firstBody.txHash);
      expect(broadcast).toHaveBeenCalledTimes(1);
    });
  });

  it("requires a key when the request broadcasts", async () => {
    await withServer({ API_TOKENS: `ops:${TOKEN}` }, async ({ baseUrl, broadcast }) => {
      const response = await post(
        baseUrl,
        "/withdrawals",
        withdrawalBody({ broadcast: true }),
        authHeaders(),
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Idempotency-Key header is required/);
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  it("rejects a key reused with a different body", async () => {
    await withServer({ API_TOKENS: `ops:${TOKEN}` }, async ({ baseUrl }) => {
      const headers = authHeaders({ "idempotency-key": "withdrawal-1" });

      const first = await post(
        baseUrl,
        "/withdrawals",
        withdrawalBody({ broadcast: true }),
        headers,
      );
      expect(first.status).toBe(201);

      const reused = await post(
        baseUrl,
        "/withdrawals",
        withdrawalBody({
          broadcast: true,
          amountWei: parseEther("0.02").toString(),
        }),
        headers,
      );

      expect(reused.status).toBe(409);
      expect(reused.body.error).toMatch(/different request body/);
    });
  });
});

describe("destination allowlist", () => {
  it("accepts the withdrawable owner address", async () => {
    await withServer(
      { WITHDRAWAL_ALLOWLIST: OWNER_ADDRESS },
      async ({ baseUrl }) => {
        const response = await post(
          baseUrl,
          "/withdrawals",
          withdrawalBody({ toAddress: OWNER_ADDRESS }),
        );

        expect(response.status).toBe(200);
        expect(response.body.transaction.to).toBe(OWNER_ADDRESS);
      },
    );
  });

  it("blocks every other destination while the owner is allowlisted", async () => {
    await withServer(
      { WITHDRAWAL_ALLOWLIST: OWNER_ADDRESS },
      async ({ baseUrl, broadcast }) => {
        const blocked = await post(
          baseUrl,
          "/withdrawals",
          withdrawalBody({ toAddress: OTHER_DESTINATION }),
        );

        expect(blocked.status).toBe(400);
        expect(blocked.body.error).toMatch(/not in the withdrawal allowlist/);
        expect(broadcast).not.toHaveBeenCalled();
      },
    );
  });

  it("blocks destinations outside the allowlist", async () => {
    await withServer(
      { WITHDRAWAL_ALLOWLIST: DESTINATION },
      async ({ baseUrl, broadcast }) => {
        const blocked = await post(
          baseUrl,
          "/withdrawals",
          withdrawalBody({ toAddress: OTHER_DESTINATION }),
        );
        expect(blocked.status).toBe(400);
        expect(blocked.body.error).toMatch(/not in the withdrawal allowlist/);

        const allowed = await post(baseUrl, "/withdrawals", withdrawalBody());
        expect(allowed.status).toBe(200);
        expect(broadcast).not.toHaveBeenCalled();
      },
    );
  });
});

describe("velocity limits", () => {
  it("caps outflow per wallet per window", async () => {
    await withServer(
      {
        WITHDRAWAL_MAX_PER_WINDOW_WEI: parseEther("0.05").toString(),
        WITHDRAWAL_WINDOW_SECONDS: "3600",
      },
      async ({ baseUrl, broadcast }) => {
        const first = await post(
          baseUrl,
          "/withdrawals",
          withdrawalBody({
            amountWei: parseEther("0.04").toString(),
            broadcast: true,
          }),
          { "idempotency-key": "velocity-1" },
        );
        expect(first.status).toBe(201);

        const second = await post(
          baseUrl,
          "/withdrawals",
          withdrawalBody({
            amountWei: parseEther("0.04").toString(),
            broadcast: true,
          }),
          { "idempotency-key": "velocity-2" },
        );

        expect(second.status).toBe(400);
        expect(second.body.error).toMatch(/remaining withdrawal allowance/);
        expect(broadcast).toHaveBeenCalledTimes(1);
      },
    );
  });
});
