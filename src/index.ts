import { formatEther } from "ethers";
import { createApp } from "./api/app.js";
import { config } from "./config/index.js";
import { initializeWallets } from "./domain/balance/balance.service.js";
import { closeDatabase } from "./infra/db/database.js";
import { startBalancePoller, stopBalancePoller } from "./jobs/balancePoller.js";

function logNetworkBanner(): void {
  console.log(
    `Network: ${config.network} (chainId ${config.chainId})${config.isTestnet ? "" : " — MAINNET"}`,
  );

  if (config.isTestnet) {
    return;
  }

  console.warn("*** MAINNET: real funds are at risk. Guardrails in effect:");
  console.warn(
    `***   per-transaction limit:     ${formatEther(config.maxTxValueWei!)} ETH`,
  );
  console.warn(
    `***   max permission grant:      ${config.permissionsMaxExpirySeconds}s`,
  );
  console.warn(
    `***   unbounded grants allowed:  ${config.allowUnboundedGrants}`,
  );
  console.warn(
    `***   database:                  ${config.databasePath} (bound to ${config.network})`,
  );
}

async function main(): Promise<void> {
  logNetworkBanner();

  const wallets = initializeWallets();
  console.log(`Initialized ${wallets.length} wallet(s) on ${config.network}`);

  startBalancePoller();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });

  const shutdown = () => {
    console.log("Shutting down...");
    stopBalancePoller();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
