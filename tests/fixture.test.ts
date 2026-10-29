import { describe, expect, it } from "vitest";
import { parseFixture, fixtureProvider } from "../src/domain/assets/fixture.js";
import { trackedContractInterface } from "../src/domain/assets/abi.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const HOLDER = "0x54f44eA3D2e7aA0ac089c4d8F7C93C27844057BF";

const FIXTURE = {
  source: "test fixture",
  recordedAt: "2026-10-28",
  contract: CONTRACT,
  symbol: "ABT",
  decimals: 18,
  totalSupply: "42591000000000000000",
  ethReserve: "42591000000000000000",
  balances: { [HOLDER.toLowerCase()]: "34505000000000000000" },
  native: { [HOLDER.toLowerCase()]: "1000000000000000" },
};

const call = (fixture: ReturnType<typeof fixtureProvider>, name: string, args: unknown[] = []) =>
  fixture.call({
    to: CONTRACT,
    data: trackedContractInterface.encodeFunctionData(name, args as never[]),
  }).then((result) =>
    trackedContractInterface.decodeFunctionResult(name, result)[0],
  );

describe("reading a fixture", () => {
  it("parses and fills in the blanks", () => {
    const parsed = parseFixture(JSON.stringify(FIXTURE));
    expect(parsed.contract).toBe(CONTRACT);
    expect(parsed.decimals).toBe(18);
  });

  it("rejects a fixture with no contract", () => {
    expect(() =>
      parseFixture(JSON.stringify({ totalSupply: "1" })),
    ).toThrow(/missing `contract`/);
  });
});

describe("the fixture provider", () => {
  it("answers the calls the report makes", async () => {
    const provider = fixtureProvider(parseFixture(JSON.stringify(FIXTURE)));

    expect(await call(provider, "decimals")).toBe(18n);
    expect(await call(provider, "symbol")).toBe("ABT");
    expect(await call(provider, "totalSupply")).toBe(42591000000000000000n);
    expect(await call(provider, "balanceOf", [HOLDER])).toBe(
      34505000000000000000n,
    );
  });

  it("reads the contract's own balance as the reserve", async () => {
    const provider = fixtureProvider(parseFixture(JSON.stringify(FIXTURE)));
    expect(await provider.getBalance(CONTRACT)).toBe(42591000000000000000n);
  });

  it("reports recorded ETH", async () => {
    const provider = fixtureProvider(parseFixture(JSON.stringify(FIXTURE)));
    expect(await provider.getBalance(HOLDER)).toBe(1000000000000000n);
  });

  it("refuses to call unrecorded ETH zero", async () => {
    // The whole point: an unknown ETH balance must not become "gas-blocked".
    const provider = fixtureProvider(parseFixture(JSON.stringify(FIXTURE)));

    await expect(provider.getBalance("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).rejects.toThrow(
      /unknown, not zero/,
    );
  });

  it("refuses to answer for a contract it does not describe", async () => {
    const provider = fixtureProvider(parseFixture(JSON.stringify(FIXTURE)));

    await expect(
      provider.call({ to: HOLDER, data: "0x70a08231" }),
    ).rejects.toThrow(/only knows/);
  });
});
