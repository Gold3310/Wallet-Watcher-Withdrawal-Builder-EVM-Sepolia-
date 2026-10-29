/**
 * Discovering who holds ABT, without trusting an indexer.
 *
 * The contract cannot list its holders — there is no enumeration in WETH9, and
 * `balanceOf` is a mapping you must already hold a key for. But the *accounts*
 * are recoverable from logs, and once you have candidate addresses the contract
 * will tell you exactly what each holds today.
 *
 * So: **enumerate from logs, then read live balances.** Not one or the other.
 *
 * Two details that are easy to get wrong and both matter:
 *
 * - `deposit()` emits `Deposit(dst, wad)` and, in canonical WETH9, **no
 *   `Transfer` at all**. Scanning `Transfer` alone silently misses everyone
 *   who got their ABT by wrapping ETH rather than receiving it. Both events
 *   are scanned here.
 *
 * - Balances are then read with `balanceOf`, not reconstructed from logs.
 *   A log-derived balance goes stale the moment anyone moves; the getter is
 *   authoritative. (Contrary to a claim that circulates, `balanceOf(address)`
 *   *is* public — `public` mappings generate a getter, and this module calls
 *   it. What the contract cannot do is *enumerate*, which is different.)
 */
import { getAddress, Interface } from "ethers";
import { trackedContractInterface } from "./abi.js";

export interface RawLog {
  topics: string[];
  data: string;
  blockNumber: number;
}

export interface HolderScanProvider {
  call(tx: { to: string; data: string }): Promise<string>;
  getLogs(filter: {
    address: string;
    topics: (string | null)[];
    fromBlock: number | string;
    toBlock: number | string;
  }): Promise<RawLog[]>;
}

export interface HolderScanOptions {
  fromBlock?: number;
  toBlock?: number;
  /** Blocks per getLogs request. Providers cap the range, so this matters. */
  chunkSize?: number;
}

export interface DiscoveredHolder {
  address: string;
  balance: bigint;
}

export interface HolderScanResult {
  contract: string;
  fromBlock: number;
  toBlock: number;
  /** Addresses that ever received ABT, before the balance check. */
  candidates: number;
  /** Those still holding something, richest first. */
  holders: DiscoveredHolder[];
  /**
   * Candidates whose balance could not be read. Reported rather than dropped:
   * if a holder is invisible here, that must be visible too.
   */
  unreadable: string[];
  /** Null when totalSupply could not be read. */
  totalSupply: bigint | null;
  /** Blocks scanned, for the record. */
  blocksScanned: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function topicOf(name: string): string {
  return trackedContractInterface.getEvent(name)?.topicHash ?? "";
}

/**
 * Every address that has ever received ABT, from `Transfer` and `Deposit`.
 *
 * Includes senders as well as receivers: an address can hold a balance without
 * ever having received one in the scanned window if it held it already.
 */
export async function discoverCandidates(
  provider: HolderScanProvider,
  contract: string,
  options: HolderScanOptions = {},
): Promise<string[]> {
  const fromBlock = options.fromBlock ?? 0;
  const toBlock = options.toBlock ?? 0;
  const chunkSize = options.chunkSize ?? 10_000;

  const candidates = new Set<string>();
  const eventNames = ["Transfer", "Deposit"];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);

    for (const name of eventNames) {
      const logs = await provider.getLogs({
        address: contract,
        topics: [topicOf(name)],
        fromBlock: start,
        toBlock: end,
      });

      for (const log of logs) {
        const parsed = trackedContractInterface.parseLog({
          topics: log.topics,
          data: log.data,
        });
        if (parsed === null) {
          continue;
        }

        for (const key of ["dst", "src", "guy"]) {
          const value = parsed.args[key];
          if (
            typeof value === "string" &&
            value.toLowerCase() !== ZERO_ADDRESS
          ) {
            candidates.add(value.toLowerCase());
          }
        }
      }
    }
  }

  return [...candidates];
}

/** Current balance of each address, zeroes discarded. */
export async function readBalances(
  provider: HolderScanProvider,
  contract: string,
  addresses: string[],
): Promise<{ holders: DiscoveredHolder[]; unreadable: string[] }> {
  const data = trackedContractInterface.encodeFunctionData("balanceOf", [
    ZERO_ADDRESS,
  ]);
  // balanceOf(address): replace the 32-byte argument per address.
  const selector = data.slice(0, 10);

  const holders: DiscoveredHolder[] = [];
  const unreadable: string[] = [];

  for (const address of addresses) {
    let balance: bigint | null = null;
    try {
      const result = await provider.call({
        to: contract,
        data: selector + address.slice(2).toLowerCase().padStart(64, "0"),
      });
      balance = trackedContractInterface.decodeFunctionResult(
        "balanceOf",
        result,
      )[0] as bigint;
    } catch {
      // Unreadable is reported, not recorded as zero. A gap is not a zero.
      unreadable.push(address);
      continue;
    }

    if (balance !== null && balance > 0n) {
      holders.push({ address, balance });
    }
  }

  return {
    holders: holders.sort((a, b) => (b.balance > a.balance ? 1 : -1)),
    unreadable,
  };
}

/**
 * Full discovery: enumerate candidates from logs, then ask the contract what
 * each of them holds right now.
 */
export async function scanHolders(
  provider: HolderScanProvider,
  contract: string,
  options: HolderScanOptions = {},
): Promise<HolderScanResult> {
  const fromBlock = options.fromBlock ?? 0;
  const toBlock = options.toBlock ?? 0;

  const candidates = await discoverCandidates(provider, contract, {
    ...options,
    fromBlock,
    toBlock,
  });

  const { holders, unreadable } = await readBalances(
    provider,
    contract,
    candidates,
  );

  let totalSupply: bigint | null = null;
  try {
    const result = await provider.call({
      to: contract,
      data: trackedContractInterface.encodeFunctionData("totalSupply"),
    });
    totalSupply = trackedContractInterface.decodeFunctionResult(
      "totalSupply",
      result,
    )[0] as bigint;
  } catch {
    totalSupply = null;
  }

  return {
    contract,
    fromBlock,
    toBlock,
    candidates: candidates.length,
    holders: holders.map((holder) => ({
      address: getAddress(holder.address),
      balance: holder.balance,
    })),
    unreadable: unreadable.map((address) => getAddress(address)),
    totalSupply,
    blocksScanned: toBlock - fromBlock + 1,
  };
}
