import { describe, expect, it } from "vitest";
import {
  addressFromTopic,
  loadEvidence,
  netFlows,
  summarize,
  unboundedApprovals,
} from "../src/domain/evidence/analysis.js";
import { APPROVAL_TOPIC0, EventRow, TRANSFER_TOPIC0 } from "../src/domain/evidence/types.js";
import {
  EvidenceLog,
  EvidenceProvider,
  EvidenceReceipt,
  isFullyVerified,
  verifyEvidence,
  verifyRow,
} from "../src/domain/evidence/verify.js";

const dataset = loadEvidence();
const rows = dataset.rows;
const first = rows[0]!;
const hub = "0xb4998dcca90f1249bc4cf0df2b732bf5034f82da";
const hubChecksummed = "0xB4998DcCa90f1249bC4cF0DF2b732bf5034F82dA";

function providerFor(
  row: EventRow,
  overrides: Partial<EvidenceReceipt> = {},
): EvidenceProvider {
  const log = {
    address: row.contractAddress,
    topics: row.topics.filter((topic): topic is string => topic !== null),
    data: row.data,
  };

  return {
    getTransactionReceipt: async () => ({
      blockNumber: row.blockNumber,
      blockHash: row.blockHash,
      logs: Array.from({ length: row.logIndex + 1 }, (_, index) =>
        index === row.logIndex
          ? log
          : { address: "0x0000000000000000000000000000000000000000", topics: [], data: "0x" },
      ),
      ...overrides,
    }),
    getBlockNumber: async () => row.blockNumber + 100,
    getNetwork: async () => ({ chainId: 137 }),
  };
}

describe("evidence dataset", () => {
  it("loads with the shape the analysis expects", () => {
    expect(dataset.rows.length).toBe(19);
    expect(dataset.tokenContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(dataset.limitations.length).toBeGreaterThan(0);
  });

  it("reproduces the counts from the source summary", () => {
    const summary = summarize(rows);

    expect(summary.rows).toBe(19);
    expect(summary.complete).toBe(18);
    expect(summary.incomplete).toBe(1);
    expect(summary.uniqueTxHashes).toBe(12);
    expect(summary.uniqueBlockHashes).toBe(12);
    expect(summary.byEventType.Transfer).toBe(16);
    expect(summary.byEventType.Approval).toBe(3);
    expect(summary.blockRange).toEqual({ from: 85921676, to: 86369971 });
  });

  it("checksums addresses out of 32-byte topics", () => {
    expect(addressFromTopic(`0x${"0".repeat(24)}${hub.slice(2)}`)).toBe(hubChecksummed);
    expect(addressFromTopic(null)).toBeNull();
  });

  it("balances: every inflow has a matching outflow", () => {
    const flows = netFlows(rows);
    const total = flows.reduce((sum, flow) => sum + BigInt(flow.net), 0n);

    expect(flows.length).toBeGreaterThan(0);
    expect(total).toBe(0n);
    expect(flows.map((flow) => flow.address)).toContain(hubChecksummed);
  });

  it("flags the unlimited approval and only that", () => {
    const unbounded = unboundedApprovals(rows);

    expect(unbounded).toHaveLength(1);
    expect(unbounded[0]!.topics[0]).toBe(APPROVAL_TOPIC0);
    expect(BigInt(unbounded[0]!.value)).toBe((1n << 256n) - 1n);
  });

  it("excludes incomplete rows from flow maths", () => {
    const incomplete = rows.filter((row) => row.incomplete);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]!.to).toBeNull();
    // Value is still recoverable from the data field.
    expect(incomplete[0]!.value).toBe("348240178375546745219");
  });
});

describe("on-chain verification", () => {
  it("verifies a row that matches exactly", async () => {
    const result = await verifyRow(first, providerFor(first));

    expect(result.status).toBe("VERIFIED");
    expect(result.notes).toEqual([]);
    expect(result.checks.blockNumber).toBe(true);
    expect(result.checks.data).toBe(true);
  });

  it("flags a block hash that disagrees with the chain", async () => {
    const result = await verifyRow(
      first,
      providerFor(first, { blockHash: "0x" + "11".repeat(32) }),
    );

    expect(result.status).toBe("MISMATCH");
    expect(result.notes.join(" ")).toMatch(/blockHash does not match/);
  });

  it("flags a log whose data differs", async () => {
    const provider: EvidenceProvider = {
      getTransactionReceipt: async () => {
        const logs: EvidenceLog[] = Array.from({ length: first.logIndex + 1 }, () => ({
          address: "0x0000000000000000000000000000000000000000",
          topics: [],
          data: "0x",
        }));
        logs[first.logIndex] = {
          address: first.contractAddress,
          topics: first.topics.filter((topic): topic is string => topic !== null),
          data: "0x" + "00".repeat(32),
        };
        return { blockNumber: first.blockNumber, blockHash: first.blockHash, logs };
      },
      getBlockNumber: async () => first.blockNumber,
    };

    const result = await verifyRow(first, provider);
    expect(result.status).toBe("MISMATCH");
    expect(result.notes.join(" ")).toMatch(/data does not match/);
  });

  it("reports a transaction the chain does not have", async () => {
    const provider: EvidenceProvider = {
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => first.blockNumber,
    };

    const result = await verifyRow(first, provider);
    expect(result.status).toBe("MISSING_TX");
  });

  it("reports a log index outside the receipt", async () => {
    const result = await verifyRow(first, providerFor(first, { logs: [] }));
    expect(result.status).toBe("MISSING_LOG");
  });

  it("skips rows marked incomplete instead of guessing", async () => {
    const incomplete = rows.find((row) => row.incomplete)!;
    const result = await verifyRow(incomplete, providerFor(incomplete));

    expect(result.status).toBe("SKIPPED_INCOMPLETE");
    expect(result.notes.join(" ")).toMatch(/truncated/i);
  });

  it("summarises a full run", async () => {
    const byTx = new Map<string, EventRow[]>();
    for (const row of rows) {
      if (row.incomplete) {
        continue;
      }
      byTx.set(row.txHash, [...(byTx.get(row.txHash) ?? []), row]);
    }

    const provider: EvidenceProvider = {
      getTransactionReceipt: async (txHash) => {
        const list = byTx.get(txHash);
        if (!list) {
          return null;
        }
        const logs: EvidenceLog[] = Array.from(
          { length: Math.max(...list.map((r) => r.logIndex)) + 1 },
          () => ({
            address: "0x0000000000000000000000000000000000000000",
            topics: [],
            data: "0x",
          }),
        );
        for (const row of list) {
          logs[row.logIndex] = {
            address: row.contractAddress,
            topics: row.topics.filter((topic): topic is string => topic !== null),
            data: row.data,
          };
        }
        return { blockNumber: list[0]!.blockNumber, blockHash: list[0]!.blockHash, logs };
      },
      getBlockNumber: async () => 86_369_971,
      getNetwork: async () => ({ chainId: 137 }),
    };

    const report = await verifyEvidence(rows, provider);

    expect(report.chainId).toBe(137);
    expect(report.head).toBe(86_369_971);
    expect(report.summary.VERIFIED).toBe(18);
    expect(report.summary.SKIPPED_INCOMPLETE).toBe(1);
    expect(report.summary.MISMATCH).toBe(0);
    expect(report.summary.MISSING_TX).toBe(0);
    expect(isFullyVerified(report)).toBe(true);
  });

});
