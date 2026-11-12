import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { parseEther } from "ethers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import { resetDatabase } from "../src/infra/db/database.js";
import { resetProvider, setProvider } from "../src/infra/rpc/provider.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("../data/standard-v1-sample.json", import.meta.url),
);

const TX_HASH = `0x${"cd".repeat(32)}`;
const FOREIGN_VAULT = "0xE2cC063DEc5685718Bd57aAC6AEE9941b25b7c37";

let baseUrl: string;
let server: Awaited<ReturnType<ReturnType<typeof createApp>["listen"]>>;

function snapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() };
}

describe("POST /withdrawals/snapshot", () => {
  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
      getBalance: vi.fn().mockResolvedValue(parseEther("1000")),
      broadcastTransaction: vi.fn().mockResolvedValue({ hash: TX_HASH }),
    } as never);
  });

  it("plans a snapshot without signing anything by default", async () => {
    const { status, body } = await post("/withdrawals/snapshot", {
      snapshot: snapshot(),
    });

    expect(status).toBe(200);
    expect(body.executed).toBe(false);
    expect(body.broadcast).toBe(false);
    expect(body.results).toEqual([]);
    expect(body.entries).toHaveLength(3);
    expect(body.entries[0].amountWei).toBe("92999650000000000000");
    expect(body.entries[0].fromWalletIndex).toBe(0);
    expect(body.entries[0].deductions.feeWei).toBe(parseEther("1").toString());
    expect(body.totals).toEqual({
      netWei: parseEther("140.498475").toString(),
      netEth: "140.498475",
    });
  });

  it("reports vaults it cannot pay from instead of guessing a wallet", async () => {
    const { body } = await post("/withdrawals/snapshot", { snapshot: snapshot() });

    expect(body.skipped).toEqual([
      expect.objectContaining({
        address: FOREIGN_VAULT,
        reason: "not-a-wallet",
      }),
    ]);
  });

  it("requires an Idempotency-Key before it will broadcast", async () => {
    const { status, body } = await post("/withdrawals/snapshot", {
      snapshot: snapshot(),
      broadcast: true,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/Idempotency-Key header is required/);
  });

  it("broadcasts each payable vault once and returns the transactions", async () => {
    const { status, body } = await post(
      "/withdrawals/snapshot",
      { snapshot: snapshot(), broadcast: true },
      { "Idempotency-Key": "snapshot-test-1" },
    );

    expect(status).toBe(201);
    expect(body.executed).toBe(true);
    expect(body.broadcast).toBe(true);
    expect(body.results).toHaveLength(3);
    expect(body.results.every((r: { txHash: string }) => r.txHash === TX_HASH)).toBe(true);
    expect(body.results[0].transaction.to).toBe(body.entries[0].address);
  });

  it("replays the stored response for the same Idempotency-Key", async () => {
    const request = { snapshot: snapshot(), broadcast: true };
    const headers = { "Idempotency-Key": "snapshot-test-2" };

    const first = await post("/withdrawals/snapshot", request, headers);
    const second = await post("/withdrawals/snapshot", request, headers);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.results).toEqual(first.body.results);
  });

  it("rejects a body with no snapshot", async () => {
    const { status, body } = await post("/withdrawals/snapshot", {});

    expect(status).toBe(400);
    expect(body.error).toMatch(/snapshot is required/);
  });

  it("rejects an unreadable leaf encoding", async () => {
    const bad = snapshot();
    bad.leafEncoding = ["address", "uint256"];

    const { status, body } = await post("/withdrawals/snapshot", { snapshot: bad });

    expect(status).toBe(400);
    expect(body.error).toMatch(/Unsupported leafEncoding/);
  });
});
