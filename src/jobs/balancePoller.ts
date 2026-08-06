import { syncAllWalletBalances } from "../domain/balance/balance.service.js";
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
}
