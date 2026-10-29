import { parseEther } from "ethers";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import { resetDatabase } from "../src/infra/db/database.js";
import { resetProvider, setProvider } from "../src/infra/rpc/provider.js";

const DESTINATION = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX_HASH =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

let baseUrl: string;
let server: Awaited<ReturnType<ReturnType<typeof createApp>["listen"]>>;

const nativePermission = (policies: unknown[] = []) => ({
  type: "native-token-transfer",
  data: {},
  policies,
});

async function grant(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("permissions routes", () => {
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

  it("grants permissions and echoes the RPC payloads", async () => {
    const { status, body } = await grant({
      fromWalletIndex: 0,
      expiry: 7 * 24 * 60 * 60,
      permissions: [
        {
          type: "contract-call",
          data: {
            address: "0x706aa5c8e5cc2c67da21ee220718f6f6b154e75c",
            calls: [{ signature: "transfer(address,uint256)" }],
          },
          policies: [],
        },
      ],
    });

    expect(status).toBe(201);
    expect(body.method).toBe("wallet_grantPermissions");
    expect(body.request.expiry).toBe(7 * 24 * 60 * 60);
    expect(body.response.permissionsContext).toMatch(/^0x77150001/);
    expect(body.response.expiry).toBeGreaterThan(body.request.expiry);
    expect(body.session.status).toBe("active");
  });

  it("returns 400 for a malformed grant", async () => {
    const missing = await grant({ expiry: 60, permissions: [nativePermission()] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/fromWalletIndex is required/);

    const badType = await grant({
      fromWalletIndex: 0,
      permissions: [{ type: "everything", data: {}, policies: [] }],
    });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toMatch(/must be one of/);
  });

  it("lists sessions, decodes contexts and revokes", async () => {
    const { body } = await grant({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [nativePermission()],
    });

    const listed = await fetch(`${baseUrl}/permissions?walletIndex=0`);
    const listedBody = await listed.json();
    expect(listedBody.sessions.map((entry: { id: number }) => entry.id)).toContain(
      body.session.id,
    );

    const context = await fetch(
      `${baseUrl}/permissions/context/${body.response.permissionsContext}`,
    );
    const contextBody = await context.json();
    expect(contextBody.context.known).toBe(true);
    expect(contextBody.context.intact).toBe(true);

    const revoked = await fetch(
      `${baseUrl}/permissions/${body.session.id}/revoke`,
      { method: "POST" },
    );
    expect((await revoked.json()).session.status).toBe("revoked");
  });

  it("redeems a session-key withdrawal", async () => {
    const { body } = await grant({
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

    const response = await fetch(
      `${baseUrl}/permissions/${body.session.id}/redeem`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "redeem-1",
        },
        body: JSON.stringify({
          toAddress: DESTINATION,
          amountWei: parseEther("0.01").toString(),
          broadcast: true,
        }),
      },
    );

    const redeemed = await response.json();

    expect(response.status).toBe(201);
    expect(redeemed.broadcast).toBe(true);
    expect(redeemed.txHash).toBe(TX_HASH);
    expect(redeemed.authorization.recoveredSigner).toBe(body.session.signer.id);
    expect(redeemed.session.nonce).toBe(1);
    expect(BigInt(redeemed.session.remainingWei)).toBe(parseEther("0.04"));
  });

  it("returns 400 when a redemption breaks a policy", async () => {
    const { body } = await grant({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [
        {
          type: "native-token-transfer",
          data: {},
          policies: [{ type: "value-limit", data: { limit: "1000" } }],
        },
      ],
    });

    const response = await fetch(
      `${baseUrl}/permissions/${body.session.id}/redeem`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toAddress: DESTINATION, amountWei: "5000" }),
      },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/value-limit/);
  });

  it("returns 400 for an unknown session", async () => {
    const response = await fetch(`${baseUrl}/permissions/999/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toAddress: DESTINATION, amountWei: "1" }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/does not exist/);
  });

  it("keeps the plain withdrawal endpoint intact", async () => {
    const response = await fetch(`${baseUrl}/withdrawals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromWalletIndex: 0,
        toAddress: DESTINATION,
        amountWei: parseEther("0.01").toString(),
        broadcast: false,
      }),
    });

    const built = await response.json();
    expect(response.status).toBe(200);
    expect(built.broadcast).toBe(false);
    expect(built.txHash).toBeNull();
    expect(built.transaction.serialized.startsWith("0x02")).toBe(true);
  });
});
