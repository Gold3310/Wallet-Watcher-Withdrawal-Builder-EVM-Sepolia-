import { parseEther } from "ethers";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import { config } from "../src/config/index.js";
import { resetDatabase } from "../src/infra/db/database.js";
import { resetProvider, setProvider } from "../src/infra/rpc/provider.js";
import { deriveWalletAtIndex } from "../src/domain/wallet/wallet.service.js";

const TX_HASH =
  "0x2222222222222222222222222222222222222222222222222222222222222222";
const TO = "0x016562aA41A8697720ce0943F003141f5dEAe006";
const FOREIGN_CHAIN = config.chainId === 1 ? "0xaa36a7" : "0x1";

const chainHex = `0x${config.chainId.toString(16)}`;

let baseUrl: string;
let server: Awaited<ReturnType<ReturnType<typeof createApp>["listen"]>>;

function specRequest(overrides: Record<string, unknown> = {}) {
  return {
    chainId: chainHex,
    to: TO,
    permission: {
      type: "native-token-allowance",
      isAdjustmentAllowed: false,
      data: { allowance: "0x0DE0B6B3A7640000" },
    },
    rules: [{ type: "expiry", data: { timestamp: Math.floor(Date.now() / 1000) + 3600 } }],
    ...overrides,
  };
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("ERC-7715 routes", () => {
  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetDatabase();
    resetProvider();
    initializeWallets();
    setProvider({
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
      getBalance: vi.fn().mockResolvedValue(parseEther("1")),
      broadcastTransaction: vi.fn().mockResolvedValue({ hash: TX_HASH }),
    } as never);
  });

  it("advertises what it supports", async () => {
    const response = await fetch(`${baseUrl}/permissions/supported`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.method).toBe("wallet_getSupportedExecutionPermissions");
    expect(Object.keys(body.result)).toContain("native-token-allowance");
    expect(body.result["native-token-allowance"].ruleTypes).toEqual(["expiry"]);
  });

  it("grants a spec-shaped permission end to end", async () => {
    const { status, body } = await post("/permissions/request", {
      fromWalletIndex: 0,
      request: specRequest(),
    });

    expect(status).toBe(201);
    expect(body.method).toBe("wallet_requestExecutionPermissions");

    // The spec's response fields, not the Openfort-era ones.
    expect(body.response.context).toMatch(/^0x77150001/);
    expect(body.response.to).toBe(TO);
    expect(Array.isArray(body.response.dependencies)).toBe(true);

    // The allowance arrived as an enforceable spending cap.
    expect(body.session.permissions[0].policies).toEqual([
      { type: "spending-cap", data: { limit: "1000000000000000000" } },
    ]);
    expect(body.session.remainingWei).toBe("1000000000000000000");
  });

  it("refuses a permission scoped to another chain", async () => {
    const { status, body } = await post("/permissions/request", {
      fromWalletIndex: 0,
      request: specRequest({ chainId: FOREIGN_CHAIN }),
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/not the chain this service is configured for/);
  });

  it("refuses when from does not match the granting wallet", async () => {
    const other = deriveWalletAtIndex(
      "test test test test test test test test test test test junk",
      1,
    ).address;

    const { status, body } = await post("/permissions/request", {
      fromWalletIndex: 0,
      request: specRequest({ from: other }),
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/is not wallet 0/);
  });

  it("refuses an expiry already in the past", async () => {
    const { status, body } = await post("/permissions/request", {
      fromWalletIndex: 0,
      request: specRequest({
        rules: [
          { type: "expiry", data: { timestamp: Math.floor(Date.now() / 1000) - 60 } },
        ],
      }),
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/already in the past/);
  });

  it("builds redemption calldata without sending it", async () => {
    const { status, body } = await post("/permissions/redeem-delegation", {
      contexts: ["0x77150001" + "22".repeat(32)],
      executions: [{ target: TO, value: "10000000000000000", callData: "0x" }],
      delegationManager: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
    });

    expect(status).toBe(200);
    expect(body.broadcast).toBe(false);
    expect(body.transaction.to).toBe(
      "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
    );
    expect(body.transaction.data.length).toBeGreaterThan(200);
  });

  it("refuses to guess a delegation manager", async () => {
    if (config.permissionsDelegationManager !== null) {
      // Configured in this environment, so the guard cannot be exercised.
      return;
    }

    const { status, body } = await post("/permissions/redeem-delegation", {
      contexts: ["0x77150001" + "22".repeat(32)],
      executions: [{ target: TO, value: "1", callData: "0x" }],
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/PERMISSIONS_DELEGATION_MANAGER/);
  });
});
