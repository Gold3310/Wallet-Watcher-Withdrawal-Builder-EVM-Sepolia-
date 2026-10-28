/**
 * Off-line analysis of event-log evidence. No network access, no conclusions —
 * this counts, sums and flags. Whether the logs are real is the verifier's job.
 */
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";
import {
  EventRow,
  EvidenceFile,
  MAX_UINT256,
  TRANSFER_TOPIC0,
  APPROVAL_TOPIC0,
} from "./types.js";

export const DEFAULT_EVIDENCE_PATH = path.resolve(
  process.cwd(),
  "evidence/erc20-transfer-events.json",
);

export function loadEvidence(filePath: string = DEFAULT_EVIDENCE_PATH): EvidenceFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as EvidenceFile;

  if (!Array.isArray(parsed.rows)) {
    throw new Error(`Evidence file has no rows array: ${filePath}`);
  }

  return parsed;
}

export function isIncomplete(row: EventRow): boolean {
  return row.incomplete === true;
}

export function completeRows(rows: EventRow[]): EventRow[] {
  return rows.filter((row) => !isIncomplete(row));
}

export function incompleteRows(rows: EventRow[]): EventRow[] {
  return rows.filter(isIncomplete);
}

/** Last 20 bytes of a 32-byte topic, checksummed. */
export function addressFromTopic(topic: string | null | undefined): string | null {
  if (!topic || topic.length < 42) {
    return null;
  }
  try {
    return getAddress(`0x${topic.slice(-40)}`);
  } catch {
    return null;
  }
}

export interface EvidenceSummary {
  rows: number;
  complete: number;
  incomplete: number;
  uniqueTxHashes: number;
  uniqueBlockHashes: number;
  byEventType: Record<string, number>;
  blockRange: { from: number; to: number } | null;
  contracts: string[];
}

export function summarize(rows: EventRow[]): EvidenceSummary {
  const txHashes = new Set<string>();
  const blockHashes = new Set<string>();
  const contracts = new Set<string>();
  const byEventType: Record<string, number> = {};
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    txHashes.add(row.txHash.toLowerCase());
    blockHashes.add(row.blockHash.toLowerCase());
    contracts.add(row.contractAddress.toLowerCase());
    byEventType[row.eventType] = (byEventType[row.eventType] ?? 0) + 1;
    from = Math.min(from, row.blockNumber);
    to = Math.max(to, row.blockNumber);
  }

  return {
    rows: rows.length,
    complete: completeRows(rows).length,
    incomplete: incompleteRows(rows).length,
    uniqueTxHashes: txHashes.size,
    uniqueBlockHashes: blockHashes.size,
    byEventType,
    blockRange: rows.length === 0 ? null : { from, to },
    contracts: [...contracts],
  };
}

export interface AddressFlow {
  address: string;
  inflow: string;
  outflow: string;
  net: string;
  transfers: number;
}

/**
 * Net token flow per address from Transfer events. Values are raw uint256, so
 * they are comparable to each other but not human-readable until divided by the
 * token's decimals.
 */
export function netFlows(rows: EventRow[]): AddressFlow[] {
  const flows = new Map<string, { in: bigint; out: bigint; count: number }>();

  const touch = (address: string) => {
    if (!flows.has(address)) {
      flows.set(address, { in: 0n, out: 0n, count: 0 });
    }
    return flows.get(address)!;
  };

  for (const row of completeRows(rows)) {
    if (row.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0) {
      continue;
    }

    const from = addressFromTopic(row.topics[1]);
    const to = addressFromTopic(row.topics[2]);
    const value = BigInt(row.value);

    if (from) {
      const entry = touch(from);
      entry.out += value;
      entry.count += 1;
    }

    if (to) {
      const entry = touch(to);
      entry.in += value;
      entry.count += 1;
    }
  }

  return [...flows.entries()]
    .map(([address, entry]) => ({
      address,
      inflow: entry.in.toString(),
      outflow: entry.out.toString(),
      net: (entry.in - entry.out).toString(),
      transfers: entry.count,
    }))
    .sort((a, b) => (BigInt(a.net) < BigInt(b.net) ? 1 : BigInt(a.net) > BigInt(b.net) ? -1 : 0));
}

/**
 * Approvals set to MAX_UINT256 — an unlimited allowance to the spender, which
 * is a common finding but not by itself evidence of anything malicious.
 */
export function unboundedApprovals(rows: EventRow[]): EventRow[] {
  return completeRows(rows).filter(
    (row) =>
      row.topics[0]?.toLowerCase() === APPROVAL_TOPIC0 &&
      BigInt(row.value) === MAX_UINT256,
  );
}
