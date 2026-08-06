import { createApp } from "./api/app.js";
import { config } from "./config/index.js";
import { initializeWallets } from "./domain/balance/balance.service.js";
import { closeDatabase } from "./infra/db/database.js";
import { startBalancePoller, stopBalancePoller } from "./jobs/balancePoller.js";

async function main(): Promise<void> {
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
