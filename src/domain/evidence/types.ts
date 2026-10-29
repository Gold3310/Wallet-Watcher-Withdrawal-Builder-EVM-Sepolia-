/**
 * Event-log evidence.
 *
 * This module holds off-chain evidence (an export of ERC-20 event logs) and the
 * machinery to check it against a chain later. Nothing here moves funds: the
 * verifier only reads receipts and compares fields.
 *
 * The data arrived without a chain id and without any on-chain confirmation, so
 * every row starts UNVERIFIED. `npm run verify:events -- <RPC_URL>` upgrades it.
 */
export type EvidenceEventType = "Transfer" | "Approval" | "Unknown";

export const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const APPROVAL_TOPIC0 =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

export const MAX_UINT256 = (1n << 256n) - 1n;

export interface EventRow {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  contractAddress: string;
  data: string;
  topics: (string | null)[];
  eventType: EvidenceEventType;
  from?: string | null;
  to?: string | null;
  owner?: string | null;
  spender?: string | null;
  /** Raw uint256 as a decimal string. Not adjusted for token decimals. */
  value: string;
  /** Set when the source row could not be captured in full. */
  incomplete?: boolean;
  incompleteReason?: string;
}

export interface EvidenceFile {
  source: string;
  network: string;
  tokenContract: string;
  verification: string;
  limitations: string[];
  notes?: string[];
  rows: EventRow[];
}
