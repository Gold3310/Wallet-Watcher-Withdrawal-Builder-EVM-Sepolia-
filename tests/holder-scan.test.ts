import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { trackedContractInterface } from "../src/domain/assets/abi.js";
import { parseFixture, fixtureProvider } from "../src/domain/assets/fixture.js";
import {
  discoverCandidates,
  readBalances,
  scanHolders,
} from "../src/domain/assets/holder.scan.js";
import type { RawLog } from "../src/domain/assets/holder.scan.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const ZERO = "0x0000000000000000000000000000000000000000";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";

const pad = (value: string) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
const toTopic = (address: string) => pad(address);
const toData = (amount: string) => pad(`0x${BigInt(amount).toString(16)}`);

function transferLog(src: string, dst: string, wad: string, block = 1): RawLog {
  return {
    topics: [
      trackedContractInterface.getEvent("Transfer")!.topicHash,
      toTopic(src),
      toTopic(dst),
    ],
    data: toData(wad),
    blockNumber: block,
  };
}

function depositLog(dst: string, wad: string, block = 1): RawLog {
  return {
    topics: [trackedContractInterface.getEvent("Deposit")!.topicHash, toTopic(dst)],
    data: toData(wad),
    blockNumber: block,
  };
}

function balanceResult(amount: string): string {
  return trackedContractInterface.encodeFunctionResult("balanceOf", [
    BigInt(amount),
  ]);
}

/** Provider whose logs depend on the requested event topic. */
function fakeProvider(options: {
  logs?: (topic: string, from: number, to: number) => RawLog[];
  balances?: Record<string, string>;
  failBalances?: boolean;
}) {
  const calls: { to: string; data: string }[] = [];
  const ranges: { from: number; to: number }[] = [];

  return {
    calls,
    ranges,
    provider: {
      async getLogs(filter: {
        address: string;
        topics: (string | null)[];
        fromBlock: number | string;
        toBlock: number | string;
      }): Promise<RawLog[]> {
        ranges.push({ from: Number(filter.fromBlock), to: Number(filter.toBlock) });
        expect(filter.address).toBe(CONTRACT);
        return (options.logs ?? (() => []))(
          filter.topics[0] as string,
          Number(filter.fromBlock),
          Number(filter.toBlock),
        );
      },
      async call(tx: { to: string; data: string }): Promise<string> {
        calls.push(tx);
        if (options.failBalances === true) {
          throw new Error("call failed");
        }
        const address = `0x${tx.data.slice(-40)}`;
        const amount = options.balances?.[address.toLowerCase()];
        if (amount === undefined) {
          return balanceResult("0");
        }
        return balanceResult(amount);
      },
    },
  };
}

describe("finding candidates in logs", () => {
  it("collects receivers from Transfer events", async () => {
    const fake = fakeProvider({
      logs: (topic) =>
        topic === trackedContractInterface.getEvent("Transfer")!.topicHash
          ? [transferLog(ZERO, ALICE, "1000"), transferLog(ALICE, BOB, "400")]
          : [],
    });

    const candidates = await discoverCandidates(fake.provider, CONTRACT, {
      fromBlock: 0,
      toBlock: 10,
    });

    expect(candidates.sort()).toEqual([ALICE, BOB].sort());
  });

  it("collects from Deposit too, which Transfer alone would miss", async () => {
    // WETH9's deposit() emits Deposit and no Transfer. Scanning Transfer only
    // silently omits everyone who wrapped ETH rather than receiving tokens.
    const fake = fakeProvider({
      logs: (topic) =>
        topic === trackedContractInterface.getEvent("Deposit")!.topicHash
          ? [depositLog(CAROL, "7000")]
          : [],
    });

    const candidates = await discoverCandidates(fake.provider, CONTRACT, {
      fromBlock: 0,
      toBlock: 10,
    });

    expect(candidates).toEqual([CAROL]);
  });

  it("ignores the zero address, which is a mint or burn marker", async () => {
    const fake = fakeProvider({
      logs: () => [transferLog(ZERO, ALICE, "1000")],
    });

    const candidates = await discoverCandidates(fake.provider, CONTRACT, {
      fromBlock: 0,
      toBlock: 10,
    });

    expect(candidates).toEqual([ALICE]);
    expect(candidates).not.toContain(ZERO);
  });

  it("requests the range in chunks, because providers cap them", async () => {
    const fake = fakeProvider({ logs: () => [] });

    await discoverCandidates(fake.provider, CONTRACT, {
      fromBlock: 0,
      toBlock: 25,
      chunkSize: 10,
    });

    // Two events scanned per chunk, so pairs of identical ranges.
    expect(new Set(fake.ranges.map((r) => `${r.from}-${r.to}`))).toEqual(
      new Set(["0-9", "10-19", "20-25"]),
    );
  });
});

describe("reading what they hold now", () => {
  it("uses the public balanceOf getter", async () => {
    const fake = fakeProvider({ balances: { [ALICE.toLowerCase()]: "1000" } });

    const { holders } = await readBalances(fake.provider, CONTRACT, [ALICE]);

    expect(holders).toEqual([{ address: ALICE, balance: 1000n }]);
    expect(fake.calls[0].data.startsWith("0x70a08231")).toBe(true);
  });

  it("discards zero balances", async () => {
    const fake = fakeProvider({ balances: { [ALICE.toLowerCase()]: "0" } });

    const { holders } = await readBalances(fake.provider, CONTRACT, [ALICE, BOB]);

    expect(holders).toEqual([]);
  });

  it("reports unreadable balances instead of dropping them silently", async () => {
    const fake = fakeProvider({ failBalances: true });

    const { holders, unreadable } = await readBalances(fake.provider, CONTRACT, [
      ALICE,
    ]);

    expect(holders).toEqual([]);
    expect(unreadable).toEqual([ALICE]);
  });
});

describe("a full scan", () => {
  it("enumerates from logs, then reads balances live", async () => {
    const fake = fakeProvider({
      logs: (topic) =>
        topic === trackedContractInterface.getEvent("Transfer")!.topicHash
          ? [
              transferLog(ZERO, ALICE, "1000"),
              transferLog(ALICE, BOB, "300"),
              transferLog(ALICE, CAROL, "200"),
            ]
          : [],
      balances: {
        [ALICE.toLowerCase()]: "500",
        [BOB.toLowerCase()]: "300",
        [CAROL.toLowerCase()]: "200",
      },
    });

    const result = await scanHolders(fake.provider, CONTRACT, {
      fromBlock: 0,
      toBlock: 100,
    });

    expect(result.candidates).toBe(3);
    expect(result.holders.map((h) => h.balance)).toEqual([500n, 300n, 200n]);
    expect(result.holders[0].address).toBe(ALICE);
    expect(result.blocksScanned).toBe(101);
  });

  it("surfaces unreadable holders in the result", async () => {
    const fake = fakeProvider({
      logs: () => [transferLog(ZERO, ALICE, "1000")],
      failBalances: true,
    });

    const result = await scanHolders(fake.provider, CONTRACT, {
      fromBlock: 0,
      toBlock: 10,
    });

    expect(result.unreadable).toEqual([ALICE]);
    expect(result.holders).toEqual([]);
  });

  it("records a null supply rather than a guessed one", async () => {
    const fake = fakeProvider({
      logs: () => [],
      failBalances: true,
    });

    const result = await scanHolders(fake.provider, CONTRACT, {
      fromBlock: 0,
      toBlock: 10,
    });

    expect(result.totalSupply).toBeNull();
  });
});

describe("the recorded fixture, replayed", () => {
  it("recovers the known holders and their shares", async () => {
    const fixture = parseFixture(
      readFileSync(path.join(process.cwd(), "fixtures", "holder-snapshot.json"), "utf8"),
    );

    const result = await scanHolders(
      fixtureProvider(fixture) as never,
      fixture.contract,
      { fromBlock: fixture.deploymentBlock ?? 0, toBlock: 20_000_999 },
    );

    expect(result.holders).toHaveLength(4);
    expect(result.unreadable).toEqual([]);

    const supply = result.totalSupply ?? 0n;
    const total = result.holders.reduce((sum, h) => sum + h.balance, 0n);
    // The fixture is built to balance, and that is worth asserting.
    expect(total).toBe(supply);

    const top = result.holders[0];
    expect(top.address).toBe("0x54f44eA3D2e7aA0ac089c4d8F7C93C27844057BF");
    // Enough integer precision to actually land on four decimal places.
    expect(Number((top.balance * 1_000_000n) / supply) / 10_000).toBeCloseTo(
      81.0148,
      3,
    );
  });

  it("refuses to invent logs for a contract it does not describe", async () => {
    const fixture = parseFixture(
      readFileSync(path.join(process.cwd(), "fixtures", "holder-snapshot.json"), "utf8"),
    );
    const provider = fixtureProvider(fixture) as never;

    await expect(
      scanHolders(provider, "0x4444444444444444444444444444444444444444", {
        fromBlock: 0,
        toBlock: 10,
      }),
    ).rejects.toThrow(/no logs for/);
  });
});
