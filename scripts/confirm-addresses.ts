/**
 * Confirms, address by address, what each one can actually do.
 *
 *     npm run addresses:confirm
 *
 * Every address in play — the contract, the service owner, the deployer, the
 * known holders, and each derived wallet — read live and classified:
 *
 *   nothing-to-redeem   no balance. Sponsoring gas changes nothing here,
 *                       because there is no claim to exercise.
 *   gas-blocked         a balance worth redeeming and no ETH to pay for the
 *                       transaction. The one case gasless actually fixes.
 *   ready               a balance and the gas to move it.
 *
 * Derived wallets are seeded here rather than requiring a server boot: on a
 * fresh database the wallets table is empty, and a report that silently omits
 * every address you control is worse than no report at all.
 *
 * That classification is the whole point. "Make it gasless" is often proposed
 * as though paying for gas were the last barrier in general. It is the last
 * barrier for exactly one of these rows, and irrelevant to the rest.
 */
import "dotenv/config";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import { config } from "../src/config/index.js";
import { getHolderReports } from "../src/domain/assets/asset.service.js";
import { assertReachable } from "../src/infra/rpc/provider.js";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  await assertReachable();

  // Idempotent: upserts the HD-derived wallets so they appear below even on a
  // database that has never been started.
  const wallets = initializeWallets();

  const reports = await getHolderReports();

  console.log(
    `${wallets.length} derived wallet(s) seeded for ${config.network} (chainId ${config.chainId})`,
  );

  console.log("");

  for (const report of reports) {
    console.log(`${report.symbol ?? "token"} at ${report.contract}`);
    console.log(
      `supply ${report.totalSupplyFormatted ?? "?"}   ETH reserve ${
        report.ethReserveFormatted ?? "?"
      }   held elsewhere ${report.thirdPartyTotalFormatted ?? "?"}`,
    );
    console.log("");
    console.log(
      `${pad("ADDRESS", 44)}${pad("BALANCE", 14)}${pad("SHARE", 10)}${pad(
        "ETH",
        12,
      )}${pad("STATUS", 20)}SIGNS`,
    );
    console.log("-".repeat(108));

    for (const row of report.holders) {
      console.log(
        `${pad(row.address, 44)}${pad(row.balanceFormatted ?? "?", 14)}${pad(
          row.shareOfSupply === null ? "?" : `${row.shareOfSupply}%`,
          10,
        )}${pad(row.nativeEth ?? "?", 12)}${pad(row.accessStatus, 20)}${
          row.signableByService ? "yes" : "no"
        }`,
      );
      console.log(`  ${row.label}`);
    }

    console.log("");
    console.log(report.verdict.replace(/(.{92}\s)/g, "$1\n"));
    console.log("");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
