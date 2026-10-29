import { syncAllWalletBalances } from "../domain/balance/balance.service.js";
import { pollHolderActivity } from "../domain/assets/holder.watcher.js";
import { config } from "../config/index.js";

let intervalHandle: NodeJS.Timeout | null = null;

export function startBalancePoller(): void {
  if (intervalHandle) {
    return;
  }

  void pollBalances("startup");

  intervalHandle = setInterval(() => {
    void pollBalances("interval");
  }, config.pollIntervalMs);

  intervalHandle.unref();
}

export function stopBalancePoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function pollBalances(trigger: "startup" | "interval"): Promise<void> {
  try {
    const changedCount = await syncAllWalletBalances();
    console.log(
      `[balance-poller:${trigger}] synced wallets, ${changedCount} balance change(s) detected`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[balance-poller:${trigger}] failed: ${message}`);
  }

  // Separate try/catch: the holder set belongs to other people's addresses,
  // and a failure to read them must not stop the wallet sync above from
  // running.
  try {
    const changes = await pollHolderActivity();

    for (const change of changes) {
      if (change.changeType === "arrived") {
        // The one worth shouting about: the token reached an address this
        // service can sign for, which is the only event that changes what is
        // possible rather than merely what is true.
        console.warn(
          `[holder-watcher:${trigger}] ${change.label} (${change.address}): ${change.detail}`,
        );
      } else {
        console.log(
          `[holder-watcher:${trigger}] ${change.changeType}: ${change.label} (${change.address}) — ${change.detail}`,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[holder-watcher:${trigger}] failed: ${message}`);
  }
}
