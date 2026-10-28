/**
 * On-chain verification of event-log evidence.
 *
 * Takes the same rows the analysis module reads offline and checks each one
 * against a chain: does the transaction exist, is it in the block we recorded,
 * does the log at that index come from that contract, and do the topics and data
 * match byte for byte.
 *
 * The provider is injected as a narrow interface, so this is testable without a
 * network and works with any JSON-RPC endpoint later.
 */
import { completeRows } from "./analysis.js";
import { EventRow } from "./types.js";

export interface EvidenceLog {
  address: string;
  topics: string[];
  data: string;
}

export interface EvidenceReceipt {
  blockNumber: number;
  blockHash: string;
  logs: EvidenceLog[];
}

export interface EvidenceProvider {
  getTransactionReceipt(txHash: string): Promise<EvidenceReceipt | null>;
  getBlockNumber(): Promise<number>;
  getNetwork?(): Promise<{ chainId: number }>;
}

export type RowStatus =
  | "VERIFIED"
  | "MISMATCH"
  | "MISSING_TX"
  | "MISSING_LOG"
  | "SKIPPED_INCOMPLETE";

export interface RowVerification {
  txHash: string;
  logIndex: number;
  status: RowStatus;
  checks: Record<string, boolean>;
  notes: string[];
}

export interface VerificationReport {
  verifiedAt: string;
  chainId: number | null;
  head: number | null;
  summary: Record<RowStatus, number>;
  rows: RowVerification[];
}

const sameHex = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export async function verifyRow(
  row: EventRow,
  provider: EvidenceProvider,
): Promise<RowVerification> {
  const base = { txHash: row.txHash, logIndex: row.logIndex, checks: {}, notes: [] as string[] };

  if (row.incomplete) {
    return {
      ...base,
      status: "SKIPPED_INCOMPLETE",
      notes: [row.incompleteReason ?? "Row is incomplete; cannot be verified."],
    };
  }

  const receipt = await provider.getTransactionReceipt(row.txHash);

  if (!receipt) {
    return { ...base, status: "MISSING_TX", notes: ["No receipt returned for this transaction hash."] };
  }

  const log = receipt.logs[row.logIndex];

  if (!log) {
    return {
      ...base,
      status: "MISSING_LOG",
      notes: [`Receipt has ${receipt.logs.length} log(s); index ${row.logIndex} is out of range.`],
    };
  }

  const checks: Record<string, boolean> = {
    blockNumber: Number(receipt.blockNumber) === row.blockNumber,
    blockHash: sameHex(receipt.blockHash, row.blockHash),
    contractAddress: sameHex(log.address, row.contractAddress),
    data: sameHex(log.data, row.data),
  };

  row.topics.forEach((topic, position) => {
    if (topic === null) {
      return;
    }
    checks[`topic${position}`] = sameHex(log.topics[position], topic);
  });

  const notes: string[] = [];
  for (const [name, ok] of Object.entries(checks)) {
    if (!ok) {
      notes.push(`${name} does not match on-chain value.`);
    }
  }

  return {
    ...base,
    status: notes.length === 0 ? "VERIFIED" : "MISMATCH",
    checks,
    notes,
  };
}

export async function verifyEvidence(
  rows: EventRow[],
  provider: EvidenceProvider,
): Promise<VerificationReport> {
  const summary: Record<RowStatus, number> = {
    VERIFIED: 0,
    MISMATCH: 0,
    MISSING_TX: 0,
    MISSING_LOG: 0,
    SKIPPED_INCOMPLETE: 0,
  };

  const results: RowVerification[] = [];

  for (const row of rows) {
    const result = await verifyRow(row, provider);
    summary[result.status] += 1;
    results.push(result);
  }

  let chainId: number | null = null;
  let head: number | null = null;

  try {
    if (provider.getNetwork) {
      chainId = Number((await provider.getNetwork()).chainId);
    }
  } catch {
    chainId = null;
  }

  try {
    head = await provider.getBlockNumber();
  } catch {
    head = null;
  }

  return {
    verifiedAt: new Date().toISOString(),
    chainId,
    head,
    summary,
    rows: results,
  };
}

/**
 * True when every row that could be checked matched on-chain. Rows skipped as
 * incomplete do not count against it, but the report will still show them.
 */
export function isFullyVerified(report: VerificationReport): boolean {
  return (
    report.summary.VERIFIED > 0 &&
    report.summary.MISMATCH === 0 &&
    report.summary.MISSING_TX === 0 &&
    report.summary.MISSING_LOG === 0
  );
}
