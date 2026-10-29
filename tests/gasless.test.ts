import { parseEther, parseUnits } from "ethers";
import { describe, expect, it, vi } from "vitest";
import {
  buildHolderReport,
  classifyAccess,
  type HolderOfInterest,
} from "../src/domain/assets/holders.js";
import {
  DirectRelayer,
  SponsoredRelayer,
  describeGasReadiness,
  selectRelayer,
} from "../src/infra/rpc/relayer.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TX_HASH = "0x" + "ab".repeat(32);

const holder = (label: string, address: string, signable: boolean): HolderOfInterest => ({
  label,
  address,
  signableByService: signable,
});

describe("why an address cannot redeem", () => {
  it("says there is nothing to redeem when the balance is zero", () => {
    expect(classifyAccess(0n, parseEther("1"), 0n)).toBe("nothing-to-redeem");
    expect(classifyAccess(0n, 0n, 0n)).toBe("nothing-to-redeem");
  });

  it("separates 'no gas' from 'no claim'", () => {
    const balance = parseUnits("5", 18);
    const redeemable = parseEther("5");

    // Balance but no ETH: the only case sponsoring gas actually fixes.
    expect(classifyAccess(balance, 0n, redeemable)).toBe("gas-blocked");
    // Balance and gas: nothing is in the way.
    expect(classifyAccess(balance, parseEther("0.01"), redeemable)).toBe("ready");
  });

  it("admits ignorance rather than guessing when ETH is unreadable", () => {
    expect(classifyAccess(parseUnits("5", 18), null, parseEther("5"))).toBe(
      "unknown",
    );
  });
});

describe("the report, per address", () => {
  function report(nativeBalances: (bigint | null)[]) {
    return buildHolderReport({
      contract: CONTRACT,
      holders: [
        holder("the contract", CONTRACT, false),
        holder("derived wallet 0", WALLET, true),
      ],
      decimals: 18,
      symbol: "ABT",
      totalSupply: parseUnits("42.591", 18),
      ethReserve: parseUnits("42.591", 18),
      balances: [0n, parseUnits("5", 18)],
      nativeBalances,
    });
  }

  it("reports ETH per address and classifies each one", () => {
    const result = report([parseEther("42.591"), 0n]);
    const wallet = result.holders[1];

    expect(wallet.nativeWei).toBe("0");
    expect(wallet.nativeEth).toBe("0.0");
    expect(wallet.accessStatus).toBe("gas-blocked");
  });

  it("says plainly what sponsoring gas would and would not fix", () => {
    const verdict = report([parseEther("42.591"), 0n]).verdict;

    expect(verdict).toMatch(/hold a redeemable balance but no ETH/);
    expect(verdict).toMatch(/it changes nothing for any address that holds no/);
  });

  it("stays quiet about gas when a wallet can already pay", () => {
    const result = report([parseEther("42.591"), parseEther("0.5")]);

    expect(result.holders[1].accessStatus).toBe("ready");
    expect(result.verdict).not.toMatch(/redeemable balance but no ETH/);
  });
});

describe("affording the transaction", () => {
  it("prices gas at the fee ceiling, not the spot price", () => {
    const readiness = describeGasReadiness(
      parseEther("0.002"),
      60_000n,
      2_000_000_000n,
    );

    // 60,000 x 2 gwei = 0.00012 ETH
    expect(readiness.costWei).toBe(120_000_000_000_000n);
    expect(readiness.sufficient).toBe(true);
    expect(readiness.shortfallWei).toBe(0n);
  });

  it("names the shortfall when the sender cannot pay", () => {
    const readiness = describeGasReadiness(0n, 60_000n, 2_000_000_000n);

    expect(readiness.sufficient).toBe(false);
    expect(readiness.shortfallWei).toBe(120_000_000_000_000n);
    expect(readiness.message).toMatch(/short by 0.00012 ETH/);
    expect(readiness.message).toMatch(
      /would do nothing for an address that holds no balance/,
    );
  });
});

describe("choosing who pays", () => {
  const provider = {
    broadcastTransaction: vi.fn().mockResolvedValue({ hash: TX_HASH }),
  };

  it("defaults to the sender paying through the node", () => {
    const relayer = selectRelayer(provider as never, null, null);

    expect(relayer).toBeInstanceOf(DirectRelayer);
    expect(relayer.name).toBe("direct");
    expect(relayer.senderPaysGas).toBe(true);
  });

  it("switches to a relay when an endpoint is configured", () => {
    const relayer = selectRelayer(
      provider as never,
      "https://relay.example/submit",
      "key",
    );

    expect(relayer).toBeInstanceOf(SponsoredRelayer);
    expect(relayer.senderPaysGas).toBe(false);
  });

  it("submits directly when the sender pays", async () => {
    const relayer = new DirectRelayer(provider as never);
    const result = await relayer.submit("0xfeedface");

    expect(provider.broadcastTransaction).toHaveBeenCalledWith("0xfeedface");
    expect(result.hash).toBe(TX_HASH);
  });
});

describe("the sponsored path", () => {
  const okResponse = (body: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  it("sends the signed transaction with the key attached", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ hash: TX_HASH }));

    const relayer = new SponsoredRelayer({
      endpoint: "https://relay.example/submit",
      apiKey: "secret",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(relayer.submit("0xfeedface")).resolves.toEqual({
      hash: TX_HASH,
    });

    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://relay.example/submit");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      signedTransaction: "0xfeedface",
    });
  });

  it("refuses to submit without a key, since that is an open relay", async () => {
    const relayer = new SponsoredRelayer({
      endpoint: "https://relay.example/submit",
      apiKey: null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(relayer.submit("0xfeedface")).rejects.toThrow(
      /Refusing to send a signed transaction to a relay unauthenticated/,
    );
  });

  it("reports an unreachable relay by name", async () => {
    const relayer = new SponsoredRelayer({
      endpoint: "https://relay.example/submit",
      apiKey: "secret",
      fetchImpl: vi
        .fn()
        .mockRejectedValue(new Error("getaddrinfo ENOTFOUND")) as unknown as typeof fetch,
    });

    await expect(relayer.submit("0xfeedface")).rejects.toThrow(
      /Could not reach the gasless relay at https:\/\/relay\.example\/submit/,
    );
  });

  it("surfaces a rejection from the relay", async () => {
    const relayer = new SponsoredRelayer({
      endpoint: "https://relay.example/submit",
      apiKey: "secret",
      fetchImpl: vi
        .fn()
        .mockResolvedValue(okResponse({ error: "insufficient credit" }, 402)) as unknown as typeof fetch,
    });

    await expect(relayer.submit("0xfeedface")).rejects.toThrow(
      /rejected the transaction with 402/,
    );
  });

  it("refuses to assume success when no hash comes back", async () => {
    const relayer = new SponsoredRelayer({
      endpoint: "https://relay.example/submit",
      apiKey: "secret",
      fetchImpl: vi.fn().mockResolvedValue(okResponse({})) as unknown as typeof fetch,
    });

    await expect(relayer.submit("0xfeedface")).rejects.toThrow(
      /Treat it as unsent/,
    );
  });
});
