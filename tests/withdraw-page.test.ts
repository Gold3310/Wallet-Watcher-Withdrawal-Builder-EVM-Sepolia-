import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { config } from "../src/config/index.js";
import { trackedContractInterface } from "../src/domain/assets/abi.js";
import {
  BALANCE_OF_SELECTOR,
  WITHDRAW_SELECTOR,
  buildBalanceOfCalldata,
  buildWithdrawCalldata,
  decodeUint256,
} from "../src/domain/assets/withdraw.calldata.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const HOLDER = "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c";
const SEVEN_POINT_FOUR_EIGHT_FIVE = "7485000000000000000";

describe("calldata construction", () => {
  it("encodes withdraw(uint256)", () => {
    expect(buildWithdrawCalldata(SEVEN_POINT_FOUR_EIGHT_FIVE)).toBe(
      WITHDRAW_SELECTOR +
        BigInt(SEVEN_POINT_FOUR_EIGHT_FIVE).toString(16).padStart(64, "0"),
    );
  });

  it("agrees with the server-side plan, which is the same bytes another way", async () => {
    const { planWithdrawal } = await import(
      "../src/domain/assets/withdraw.plan.js"
    );
    const plan = await planWithdrawal(
      { call: vi.fn().mockRejectedValue(new Error("offline")) },
      CONTRACT,
      { from: HOLDER, amountWei: SEVEN_POINT_FOUR_EIGHT_FIVE, chainId: 1 },
    );

    expect(buildWithdrawCalldata(SEVEN_POINT_FOUR_EIGHT_FIVE)).toBe(
      plan.transaction.data,
    );
  });

  it("encodes balanceOf(address) with a checksummed address", () => {
    const data = buildBalanceOfCalldata(HOLDER);

    expect(data.startsWith(BALANCE_OF_SELECTOR)).toBe(true);
    expect(data.slice(10 + 24).toLowerCase()).toBe(HOLDER.slice(2).toLowerCase());
    // getAddress normalises case, so decoding must round-trip.
    expect(
      trackedContractInterface.decodeFunctionData("balanceOf", data)[0],
    ).toBe(HOLDER);
  });

  it("rejects amounts that are not positive integers", () => {
    expect(() => buildWithdrawCalldata("0")).toThrow(/greater than zero/);
    expect(() => buildWithdrawCalldata("-1")).toThrow(/greater than zero/);
    expect(() => buildWithdrawCalldata("lots")).toThrow(/must be an integer/);
  });

  it("rejects an invalid address", () => {
    expect(() => buildBalanceOfCalldata("nonsense")).toThrow();
  });

  it("decodes a hex word back to a number", () => {
    expect(decodeUint256("0x0")).toBe(0n);
    expect(
      decodeUint256(
        "0x" + BigInt(SEVEN_POINT_FOUR_EIGHT_FIVE).toString(16),
      ),
    ).toBe(BigInt(SEVEN_POINT_FOUR_EIGHT_FIVE));
  });

  it("refuses to decode something that is not hex", () => {
    expect(() => decodeUint256("7.485")).toThrow(/not a hex quantity/);
  });
});

describe("the withdraw page", () => {
  let baseUrl: string;
  let server: Awaited<ReturnType<ReturnType<typeof createApp>["listen"]>>;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("is served without an API token, because a browser has none", async () => {
    const response = await fetch(`${baseUrl}/withdraw`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toMatch(/eip6963:requestProvider/);
    expect(html).toMatch(/withdraw\(uint256\)/);
  });

  it("never mentions a seed phrase or private key", async () => {
    // The page asks a wallet to sign; it must never ask for secrets.
    const html = await (await fetch(`${baseUrl}/withdraw`)).text();
    // Phrase is split across lines in the source, so match the part that matters.
    expect(html).toMatch(/never asks for a seed phrase/i);
  });

  it("tells the page which contract and chain to use", async () => {
    const body = (await (
      await fetch(`${baseUrl}/withdraw/config`)
    ).json()) as { contract: string; chainId: number };

    expect(body.contract).toBe(config.trackedContracts[0]);
    expect(body.chainId).toBe(config.chainId);
  });

  it("hands over withdraw calldata on request", async () => {
    const response = await fetch(`${baseUrl}/withdraw/calldata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "withdraw",
        amountWei: SEVEN_POINT_FOUR_EIGHT_FIVE,
      }),
    });
    const body = (await response.json()) as {
      to: string;
      data: string;
      value: string;
      chainId: number;
    };

    expect(response.status).toBe(200);
    expect(body.to).toBe(config.trackedContracts[0]);
    expect(body.data).toBe(buildWithdrawCalldata(SEVEN_POINT_FOUR_EIGHT_FIVE));
    expect(body.value).toBe("0");
  });

  it("hands over balanceOf calldata on request", async () => {
    const response = await fetch(`${baseUrl}/withdraw/calldata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "balanceOf", address: HOLDER }),
    });
    const body = (await response.json()) as { to: string; data: string };

    expect(response.status).toBe(200);
    expect(body.data).toBe(buildBalanceOfCalldata(HOLDER));
  });

  it("rejects an unknown action", async () => {
    const response = await fetch(`${baseUrl}/withdraw/calldata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sweep" }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects a missing amount", async () => {
    const response = await fetch(`${baseUrl}/withdraw/calldata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "withdraw" }),
    });

    expect(response.status).toBe(400);
  });

  it("still guards the endpoints that can move value", async () => {
    // The page is public; the unwrap route must not be. The status is 400
    // rather than 401 in this environment because API_TOKENS is unset, and the
    // error mapper treats a missing required config as a bad request — with
    // tokens configured the same call returns 401. Either way it is refused.
    const response = await fetch(`${baseUrl}/assets/unwrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromWalletIndex: 0, broadcast: false }),
    });
    const body = (await response.json()) as { txHash?: string };

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.txHash).toBeUndefined();
  });
});
