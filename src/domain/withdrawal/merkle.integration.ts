/**
 * Standard-v1 Merkle tree snapshot -> withdrawals.
 *
 * The snapshot is the data structure an OpenZeppelin `standard-v1` Merkle tree
 * serialises to (`format`, `tree`, `values`, `leafEncoding`) extended with the
 * distribution state that decides what each vault is actually owed:
 *
 *   - `extraValues[address]` carries the fee/delta bookkeeping per vault.
 *   - `blockHash` / `blockNumber` / `timestamp` place the snapshot on chain, and
 *     become the evidence row for the run.
 *
 * Leaf layout, per `leafEncoding`:
 *
 *   [ vault address, total value, fee, liability shares,
 *     max liability shares, slashing reserve ]
 *
 * What this module deliberately does:
 *
 * - Computes amounts in `bigint` from the encoded integers. No floats, no
 *   ethers formatting until the last possible moment.
 * - **Refuses to underflow.** A leaf whose deductions exceed its total value is
 *   a corrupt snapshot, not a zero withdrawal, so it fails the whole parse
 *   instead of quietly paying nothing.
 * - Resolves the paying wallet by *address*. The leaf says where the value sits;
 *   `fromWalletIndex` is not something a caller gets to guess. A leaf whose
 *   address is not one of the derived wallets is reported, never paid from an
 *   unrelated wallet.
 * - Signs and broadcasts nothing unless `execute` is passed. The default is a
 *   dry run that returns exactly what would be sent.
 */
import { getAddress, isAddress } from "ethers";
import { config } from "../../config/index.js";
import { EventRow } from "../evidence/types.js";
import { getAllWallets } from "../../infra/db/database.js";
import {
  createWithdrawal,
  WithdrawalRequest,
  WithdrawalResult,
} from "./withdrawal.service.js";

/** Fields every `standard-v1` tree dump carries. */
export interface StandardV1Tree {
  format: string;
  tree?: string[];
  values?: unknown[][];
  leafEncoding: string[];
}

/** Per-vault fee and delta bookkeeping, kept outside the Merkle leaves. */
export interface VaultExtraValues {
  inOutDelta?: string;
  prevFee?: string;
  infraFee?: string;
  liquidityFee?: string;
  reservationFee?: string;
}

export interface SnapshotBlock {
  blockHash: string;
  blockNumber: number;
  timestamp: number;
}

export interface StandardV1Snapshot extends StandardV1Tree {
  refSlot: string;
  prevTreeCID?: string;
  extraValues?: Record<string, VaultExtraValues>;
  leafIndexToData?: Record<string, number>;
  block?: SnapshotBlock;
  /** Flat form of the block fields; the API accepts either. */
  blockHash?: string;
  blockNumber?: number;
  timestamp?: number;
}

/** The deduction breakdown for one vault, every value in wei. */
export interface VaultBreakdown {
  address: string;
  treeIndex: number | null;
  totalValueWei: string;
  feeWei: string;
  liabilitySharesWei: string;
  maxLiabilitySharesWei: string;
  slashingReserveWei: string;
  infraFeeWei: string;
  liquidityFeeWei: string;
  reservationFeeWei: string;
  /** `totalValue - fee - liabilityShares - slashingReserve - fees`. */
  netAmountWei: string;
  /** `inOutDelta`/`prevFee` as reported; informational, not deducted twice. */
  inOutDeltaWei: string;
  prevFeeWei: string;
}

export type SkipReason =
  | "not-a-wallet"
  | "zero-amount"
  | "duplicate-address";

export interface SkippedLeaf extends VaultBreakdown {
  reason: SkipReason;
  detail: string;
}

export interface SnapshotEntry extends VaultBreakdown {
  fromWalletIndex: number;
  fromAddress: string;
  request: WithdrawalRequest;
}

export interface SnapshotPlan {
  refSlot: string;
  block: SnapshotBlock;
  network: string;
  chainId: number;
  /** Every leaf, with the deduction breakdown that produced its amount. */
  breakdowns: VaultBreakdown[];
  /** Leaves that will be paid, already mapped to a wallet index. */
  entries: SnapshotEntry[];
  /** Leaves that parsed fine but cannot be paid, with the reason. */
  skipped: SkippedLeaf[];
  totalNetWei: string;
  totalNetEth: string;
}

export interface SnapshotRun extends SnapshotPlan {
  /** False for a dry run: the plan is complete, nothing was signed. */
  executed: boolean;
  results: SnapshotResult[];
  /** One row per run, in the same shape as the event-log evidence. */
  evidence: EventRow;
}

export type SnapshotResult =
  | { status: "broadcast" | "built"; address: string; result: WithdrawalResult }
  | { status: "failed"; address: string; error: string; request: WithdrawalRequest };

const EXPECTED_LEAF_ENCODING = [
  "address",
  "uint256",
  "uint256",
  "uint256",
  "uint256",
  "uint256",
];

const ZERO = "0";

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Snapshot field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseWei(value: unknown, field: string): bigint {
  if (value === undefined || value === null || value === "") {
    return 0n;
  }

  const raw = typeof value === "string" ? value.trim() : value;

  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error(`${field} must be an unsigned integer string of wei`);
  }

  return BigInt(raw);
}

function parseBlock(snapshot: StandardV1Snapshot): SnapshotBlock {
  const block: Partial<SnapshotBlock> = snapshot.block ?? {};
  const blockNumber = block.blockNumber ?? snapshot.blockNumber;
  const blockHash = block.blockHash ?? snapshot.blockHash;
  const timestamp = block.timestamp ?? snapshot.timestamp;

  if (!Number.isInteger(blockNumber) || (blockNumber as number) < 0) {
    throw new Error("Snapshot blockNumber must be a non-negative integer");
  }

  const hash = requireString(blockHash, "blockHash");

  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("Snapshot blockHash must be a 32-byte hex string");
  }

  if (!Number.isInteger(timestamp) || (timestamp as number) <= 0) {
    throw new Error("Snapshot timestamp must be a positive unix timestamp");
  }

  return {
    blockHash: hash.toLowerCase(),
    blockNumber: blockNumber as number,
    timestamp: timestamp as number,
  };
}

/** Addresses are case-insensitive on chain; keys in the extras map are not. */
function extrasLookup(
  extras: Record<string, VaultExtraValues> | undefined,
): (address: string) => VaultExtraValues {
  const byAddress = new Map<string, VaultExtraValues>();

  for (const [address, values] of Object.entries(extras ?? {})) {
    if (!isAddress(address)) {
      throw new Error(`extraValues contains an invalid address: ${address}`);
    }
    byAddress.set(address.toLowerCase(), values ?? {});
  }

  return (address) => byAddress.get(address.toLowerCase()) ?? {};
}

function indexLookup(
  leafIndexToData: Record<string, number> | undefined,
): (address: string) => number | null {
  const byAddress = new Map<string, number>();

  for (const [address, index] of Object.entries(leafIndexToData ?? {})) {
    byAddress.set(address.toLowerCase(), index);
  }

  return (address) => byAddress.get(address.toLowerCase()) ?? null;
}

/**
 * Validates a snapshot and computes one breakdown per leaf.
 *
 * Throws on anything that would make a payout wrong or unattributable, rather
 * than skipping quietly: a malformed snapshot should be visible immediately.
 */
export function parseSnapshot(snapshot: StandardV1Snapshot): {
  refSlot: string;
  block: SnapshotBlock;
  breakdowns: VaultBreakdown[];
} {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Snapshot must be a JSON object");
  }

  const format = requireString(snapshot.format ?? "standard-v1", "format");

  if (format !== "standard-v1") {
    throw new Error(
      `Unsupported snapshot format "${format}": only standard-v1 is understood`,
    );
  }

  if (!Array.isArray(snapshot.values) || snapshot.values.length === 0) {
    throw new Error("Snapshot values must be a non-empty array of leaves");
  }

  const leafEncoding = snapshot.leafEncoding ?? EXPECTED_LEAF_ENCODING;

  if (JSON.stringify(leafEncoding) !== JSON.stringify(EXPECTED_LEAF_ENCODING)) {
    throw new Error(
      `Unsupported leafEncoding [${leafEncoding.join(", ")}]: expected ` +
        `[${EXPECTED_LEAF_ENCODING.join(", ")}]`,
    );
  }

  const refSlot = requireString(snapshot.refSlot, "refSlot");
  const block = parseBlock(snapshot);
  const extras = extrasLookup(snapshot.extraValues);
  const treeIndex = indexLookup(snapshot.leafIndexToData);

  const breakdowns: VaultBreakdown[] = snapshot.values.map((leaf, position) => {
    if (!Array.isArray(leaf) || leaf.length !== EXPECTED_LEAF_ENCODING.length) {
      throw new Error(
        `Leaf ${position} must have ${EXPECTED_LEAF_ENCODING.length} fields, ` +
          `got ${Array.isArray(leaf) ? leaf.length : typeof leaf}`,
      );
    }

    const [address, totalValue, fee, liabilityShares, maxLiabilityShares, slashingReserve] =
      leaf as [string, string, string, string, string, string];

    if (!isAddress(address)) {
      throw new Error(`Leaf ${position} has an invalid vault address: ${address}`);
    }

    const checksummed = getAddress(address);
    const extra = extras(checksummed);

    const totalValueWei = parseWei(totalValue, `leaf ${position} total value`);
    const feeWei = parseWei(fee, `leaf ${position} fee`);
    const liabilitySharesWei = parseWei(
      liabilityShares,
      `leaf ${position} liability shares`,
    );
    const maxLiabilitySharesWei = parseWei(
      maxLiabilityShares,
      `leaf ${position} max liability shares`,
    );
    const slashingReserveWei = parseWei(
      slashingReserve,
      `leaf ${position} slashing reserve`,
    );
    const infraFeeWei = parseWei(extra.infraFee, `${checksummed} infraFee`);
    const liquidityFeeWei = parseWei(extra.liquidityFee, `${checksummed} liquidityFee`);
    const reservationFeeWei = parseWei(
      extra.reservationFee,
      `${checksummed} reservationFee`,
    );

    const deductions =
      feeWei +
      liabilitySharesWei +
      slashingReserveWei +
      infraFeeWei +
      liquidityFeeWei +
      reservationFeeWei;

    // An underflow here means the snapshot contradicts itself. Paying the
    // difference out of another vault, or paying zero, would hide that.
    if (deductions > totalValueWei) {
      throw new Error(
        `Leaf ${position} (${checksummed}) deducts ${deductions} wei from a total ` +
          `value of ${totalValueWei} wei — the snapshot is inconsistent`,
      );
    }

    return {
      address: checksummed,
      treeIndex: treeIndex(checksummed),
      totalValueWei: totalValueWei.toString(),
      feeWei: feeWei.toString(),
      liabilitySharesWei: liabilitySharesWei.toString(),
      maxLiabilitySharesWei: maxLiabilitySharesWei.toString(),
      slashingReserveWei: slashingReserveWei.toString(),
      infraFeeWei: infraFeeWei.toString(),
      liquidityFeeWei: liquidityFeeWei.toString(),
      reservationFeeWei: reservationFeeWei.toString(),
      netAmountWei: (totalValueWei - deductions).toString(),
      inOutDeltaWei: parseWei(extra.inOutDelta, `${checksummed} inOutDelta`).toString(),
      prevFeeWei: parseWei(extra.prevFee, `${checksummed} prevFee`).toString(),
    };
  });

  const seen = new Set<string>();
  for (const breakdown of breakdowns) {
    const key = breakdown.address.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Snapshot lists vault ${breakdown.address} more than once`);
    }
    seen.add(key);
  }

  return { refSlot, block, breakdowns };
}

/**
 * Maps vault addresses to the wallet that pays them.
 *
 * The vault address is the wallet address: value sits in a wallet derived from
 * the mnemonic, so the payer is known exactly. Anything else is skipped with a
 * reason rather than defaulted to wallet 0 — paying one vault out of another
 * vault's balance is the one mistake this must never make.
 */
export function buildSnapshotPlan(
  snapshot: StandardV1Snapshot,
  options: { broadcast?: boolean; actor?: string | null } = {},
): SnapshotPlan {
  const { refSlot, block, breakdowns } = parseSnapshot(snapshot);

  const walletIndexByAddress = new Map<string, number>();
  for (const wallet of getAllWallets()) {
    walletIndexByAddress.set(wallet.address.toLowerCase(), wallet.index);
  }

  const broadcast = options.broadcast ?? false;
  const actor = options.actor ?? null;
  const entries: SnapshotEntry[] = [];
  const skipped: SkippedLeaf[] = [];
  const claimed = new Set<number>();

  for (const breakdown of breakdowns) {
    const walletIndex = walletIndexByAddress.get(breakdown.address.toLowerCase());

    if (walletIndex === undefined) {
      skipped.push({
        ...breakdown,
        reason: "not-a-wallet",
        detail:
          `${breakdown.address} is not one of the derived wallets, so the ` +
          "snapshot cannot say which wallet would pay it",
      });
      continue;
    }

    if (claimed.has(walletIndex)) {
      skipped.push({
        ...breakdown,
        reason: "duplicate-address",
        detail: `wallet ${walletIndex} is already claimed by an earlier leaf`,
      });
      continue;
    }

    if (BigInt(breakdown.netAmountWei) === 0n) {
      skipped.push({
        ...breakdown,
        reason: "zero-amount",
        detail: "deductions consume the entire total value",
      });
      continue;
    }

    claimed.add(walletIndex);

    entries.push({
      ...breakdown,
      fromWalletIndex: walletIndex,
      fromAddress: breakdown.address,
      request: {
        fromWalletIndex: walletIndex,
        toAddress: breakdown.address,
        amountWei: breakdown.netAmountWei,
        broadcast,
        actor,
      },
    });
  }

  const totalNet = entries.reduce(
    (sum, entry) => sum + BigInt(entry.netAmountWei),
    0n,
  );

  return {
    refSlot,
    block,
    network: config.network,
    chainId: config.chainId,
    breakdowns,
    entries,
    skipped,
    totalNetWei: totalNet.toString(),
    totalNetEth: formatWeiAsEth(totalNet),
  };
}

/**
 * Runs a snapshot: plans it, then — only when `execute` is true — builds and
 * (if `broadcast` is set) sends each entry.
 *
 * Failures are per entry. One vault whose transaction cannot be built does not
 * stop the others, and the failed entry keeps its request so an operator can
 * retry exactly that one.
 */
export async function processStandardV1Snapshot(
  snapshot: StandardV1Snapshot,
  options: {
    execute?: boolean;
    broadcast?: boolean;
    actor?: string | null;
  } = {},
): Promise<SnapshotRun> {
  const plan = buildSnapshotPlan(snapshot, {
    broadcast: options.broadcast,
    actor: options.actor,
  });

  if (!options.execute) {
    return {
      ...plan,
      executed: false,
      results: [],
      evidence: buildEvidenceRow(plan, false, []),
    };
  }

  // Sequential on purpose: every entry draws a nonce from the same wallet set,
  // and a partial ordering is easier to read in the ledger than a burst.
  const results: SnapshotResult[] = [];

  for (const entry of plan.entries) {
    try {
      const result = await createWithdrawal(entry.request);
      results.push({ status: result.broadcast ? "broadcast" : "built", address: entry.address, result });
    } catch (error) {
      results.push({
        status: "failed",
        address: entry.address,
        error: error instanceof Error ? error.message : String(error),
        request: entry.request,
      });
    }
  }

  return {
    ...plan,
    executed: true,
    results,
    evidence: buildEvidenceRow(plan, true, results),
  };
}

/**
 * A single evidence row describing the run.
 *
 * It reuses the event-log `EventRow` shape so a snapshot run sits next to
 * ordinary chain evidence in one export. The block fields are the snapshot's,
 * not a transaction's: this row records *what the tree said*, which is what
 * makes a payout checkable afterwards. `txHash` is synthetic and prefixed
 * `snapshot:` so it can never be mistaken for a real transaction hash.
 */
export function buildEvidenceRow(
  plan: SnapshotPlan,
  executed: boolean,
  results: SnapshotResult[],
): EventRow {
  const sent = results.filter(
    (result): result is Extract<SnapshotResult, { status: "broadcast" | "built" }> =>
      result.status !== "failed",
  );

  return {
    txHash: `snapshot:${plan.refSlot}`,
    logIndex: 0,
    blockNumber: plan.block.blockNumber,
    blockHash: plan.block.blockHash,
    contractAddress: "standard-v1",
    data: JSON.stringify({
      refSlot: plan.refSlot,
      timestamp: plan.block.timestamp,
      executed,
      entries: plan.entries.map((entry) => ({
        address: entry.address,
        fromWalletIndex: entry.fromWalletIndex,
        treeIndex: entry.treeIndex,
        amountWei: entry.netAmountWei,
        totalValueWei: entry.totalValueWei,
        feeWei: entry.feeWei,
        liabilitySharesWei: entry.liabilitySharesWei,
        maxLiabilitySharesWei: entry.maxLiabilitySharesWei,
        slashingReserveWei: entry.slashingReserveWei,
        infraFeeWei: entry.infraFeeWei,
        liquidityFeeWei: entry.liquidityFeeWei,
        reservationFeeWei: entry.reservationFeeWei,
      })),
      skipped: plan.skipped.map((leaf) => ({
        address: leaf.address,
        reason: leaf.reason,
        netAmountWei: leaf.netAmountWei,
      })),
      results: sent.map((result) => ({
        address: result.address,
        status: result.status,
        hash: result.result.built.hash,
        txHash: result.result.txHash ?? null,
      })),
      failed: results
        .filter((result) => result.status === "failed")
        .map((result) => result.address),
    }),
    topics: [],
    eventType: "Unknown",
    value: plan.totalNetWei,
  };
}

/** Exact wei -> ETH string, no rounding. `formatEther` is a thin call but this
 * keeps the module free of ethers formatting semantics in one place. */
function formatWeiAsEth(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10n ** 18n;
  const fraction = (absolute % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export { ZERO };
