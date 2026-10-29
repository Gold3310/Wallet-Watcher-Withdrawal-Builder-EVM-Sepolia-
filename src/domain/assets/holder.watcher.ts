/**
 * Watching the addresses that decide the outcome.
 *
 * The existing poller syncs *your* wallets, which is the right thing to do and
 * answers the wrong question here: those wallets hold nothing, so a change in
 * them tells you nothing about the balance you are watching. The balances that
 * matter belong to other people.
 *
 * So this watches them. Every poll reads the holder set, diffs it against the
 * last observation, and records what moved. Nothing here transacts — it is a
 * watcher, not a strategy.
 *
 * The classification is the point. "A balance changed" is not information you
 * can act on; "a holder redeemed" and "the token arrived at an address you
 * control" are completely different events, and only the classification tells
 * you which happened:
 *
 * - `holder-redeemed` — ABT fell *and* the ETH reserve fell with it. Someone
 *   burned the token and took the ETH. The supply just got smaller.
 * - `holder-transferred` — ABT fell while the reserve held. It changed hands;
 *   nothing was redeemed.
 * - `holder-received` — ABT arrived somewhere.
 * - `reserve-moved` — the ETH backing moved without balances changing.
 * - `arrived` — ABT landed at an address this service can sign for. This is
 *   the event that changes what is possible, and the only one worth waking
 *   someone for.
 */
import type { JsonRpcProvider } from "ethers";
import { config } from "../../config/index.js";
import {
  getLatestHolderSnapshots,
  insertHolderSnapshot,
} from "../../infra/db/database.js";
import { getProvider } from "../../infra/rpc/provider.js";
import { holdersOfInterest } from "./asset.service.js";
import { readHolderReport, type HolderBalance } from "./holders.js";

export type HolderChangeType =
  | "initial"
  | "unchanged"
  | "holder-redeemed"
  | "holder-transferred"
  | "holder-received"
  | "reserve-moved"
  | "arrived";

export interface HolderChange {
  contract: string;
  address: string;
  label: string;
  changeType: HolderChangeType;
  detail: string;
  balanceRaw: string;
  previousBalanceRaw: string | null;
  ethReserveRaw: string;
  signableByService: boolean;
  observedAt: number;
}

export interface PreviousObservation {
  balance_raw: string;
  native_raw: string;
  eth_reserve_raw: string;
}

/**
 * Classifies one address against its last observation.
 *
 * Order matters: `arrived` is checked before the generic balance rules because
 * ABT reaching an address you control is the one event that changes what is
 * possible, and it would otherwise be buried under "holder-received".
 */
export function classifyChange(
  current: HolderBalance,
  previous: PreviousObservation | undefined,
  ethReserve: bigint,
  isContractRow: boolean,
): { changeType: HolderChangeType; detail: string } {
  const balance = current.balanceRaw === null ? 0n : BigInt(current.balanceRaw);

  if (previous === undefined) {
    return {
      changeType: "initial",
      detail: `first observation: ${current.balanceFormatted ?? "?"} held`,
    };
  }

  const previousBalance = BigInt(previous.balance_raw);
  const previousReserve = BigInt(previous.eth_reserve_raw);
  const delta = balance - previousBalance;

  if (current.signableByService && previousBalance === 0n && balance > 0n) {
    return {
      changeType: "arrived",
      detail:
        `${current.balanceFormatted ?? balance.toString()} arrived at an ` +
        `address this service can sign for. This is the event that changes ` +
        `what is possible — it can be redeemed for ETH now.`,
    };
  }

  if (delta < 0n && ethReserve < previousReserve) {
    return {
      changeType: "holder-redeemed",
      detail:
        `balance fell by ${(-delta).toString()} and the ETH reserve fell with ` +
        `it — this holder redeemed`,
    };
  }

  if (delta < 0n) {
    return {
      changeType: "holder-transferred",
      detail:
        `balance fell by ${(-delta).toString()} while the reserve held — it ` +
        `changed hands, nothing was redeemed`,
    };
  }

  if (delta > 0n) {
    return {
      changeType: "holder-received",
      detail: `balance rose by ${delta.toString()}`,
    };
  }

  // The reserve is one number per contract, so only the contract's own row may
  // report it. Otherwise every holder would raise the same alarm.
  if (isContractRow && ethReserve !== previousReserve) {
    return {
      changeType: "reserve-moved",
      detail:
        `ETH reserve went from ${previousReserve.toString()} to ` +
        `${ethReserve.toString()} with no change in balances`,
    };
  }

  return { changeType: "unchanged", detail: "no movement since last poll" };
}

/**
 * Polls every tracked contract once and records what moved.
 *
 * Unchanged rows are not written: history should read as a list of things that
 * happened, and a table of no-ops is noise that grows forever.
 */
export async function pollHolderActivity(
  provider?: JsonRpcProvider,
): Promise<HolderChange[]> {
  const resolved = provider ?? getProvider();
  const holderSets = holdersOfInterest();
  const now = Math.floor(Date.now() / 1000);
  const changes: HolderChange[] = [];

  for (let i = 0; i < config.trackedContracts.length; i += 1) {
    const contract = config.trackedContracts[i];
    const report = await readHolderReport(
      resolved as never,
      contract,
      holderSets[i],
    );

    const reserve = report.ethReserveRaw === null ? 0n : BigInt(report.ethReserveRaw);
    const previous = getLatestHolderSnapshots(contract);

    for (const holder of report.holders) {
      const prior = previous.get(holder.address.toLowerCase());
      const isContractRow =
        holder.address.toLowerCase() === contract.toLowerCase();

      const { changeType, detail } = classifyChange(
        holder,
        prior,
        reserve,
        isContractRow,
      );

      if (changeType === "unchanged") {
        continue;
      }

      const change: HolderChange = {
        contract,
        address: holder.address,
        label: holder.label,
        changeType,
        detail,
        balanceRaw: holder.balanceRaw ?? "0",
        previousBalanceRaw: prior?.balance_raw ?? null,
        ethReserveRaw: reserve.toString(),
        signableByService: holder.signableByService,
        observedAt: now,
      };

      insertHolderSnapshot({
        contract,
        address: holder.address,
        label: holder.label,
        balance_raw: change.balanceRaw,
        native_raw: holder.nativeWei ?? "0",
        eth_reserve_raw: reserve.toString(),
        signable: holder.signableByService ? 1 : 0,
        change_type: changeType,
        detail,
        observed_at: now,
      });

      changes.push(change);
    }
  }

  return changes;
}
