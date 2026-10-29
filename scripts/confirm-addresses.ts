/**
 * Confirms, address by address, what each one can actually do.
 *
 *     npm run addresses:confirm                  # live, needs an RPC endpoint
 *     npm run addresses:confirm -- --offline     # recorded fixture, no network
 *
 * Every address in play — the contract, the service owner, the deployer, the
 * known holders, and each derived wallet — read and classified:
 *
 *   nothing-to-redeem   no balance. Sponsoring gas changes nothing here,
 *                       because there is no claim to exercise.
 *   gas-blocked         a balance worth redeeming and no ETH to pay for the
 *                       transaction. The one case gasless fixes.
 *   ready               a balance and the gas to move it.
 *
 * That classification is the whole point. "Make it gasless" is often proposed
 * as though paying for gas were the last barrier in general. It is the last
 * barrier for exactly one of these rows, and irrelevant to the rest.
 *
 * `--offline` rebuilds the report from a recorded snapshot through the same
 * code path a live run uses, so the output can be inspected and the render
 * exercised without a network. It is labelled loudly on every line it owns:
 * a report that looks live and is not is worse than no report at all.
 *
 * Derived wallets are seeded here rather than requiring a server boot: on a
 * fresh database the wallets table is empty, and a report that silently omits
 * every address you control is worse than no report at all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import {
  fixtureProvider,
  parseFixture,
} from "../src/domain/assets/fixture.js";
import { config } from "../src/config/index.js";
import { getHolderReports } from "../src/domain/assets/asset.service.js";
import type { HolderReport } from "../src/domain/assets/holders.js";
import { assertReachable } from "../src/infra/rpc/provider.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const flag = (name: string) => process.argv.includes(`--${name}`);

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printReports(reports: HolderReport[]): void {
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

async function offline(): Promise<void> {
  const fixturePath = path.resolve(
    process.cwd(),
    arg("fixture") ?? path.join("fixtures", "holder-snapshot.json"),
  );

  const fixture = parseFixture(readFileSync(fixturePath, "utf8"));

  if (
    !config.trackedContracts.some(
      (address) => address.toLowerCase() === fixture.contract.toLowerCase(),
    )
  ) {
    throw new Error(
      `The fixture describes ${fixture.contract}, but this service is ` +
        `tracking ${config.trackedContracts.join(", ") || "nothing"}. Set ` +
        `TRACKED_CONTRACT to the fixture's contract to read it offline.`,
    );
  }

  const wallets = initializeWallets();
  const reports = await getHolderReports(fixtureProvider(fixture) as never);

  console.log("OFFLINE — RECORDED DATA, NOT A LIVE READ");
  console.log(`source: ${fixture.source}`);
  console.log(`recorded: ${fixture.recordedAt}`);
  console.log(
    "These balances are a snapshot. Nothing here was read from a chain just now.",
  );
  console.log(`${wallets.length} derived wallet(s) seeded`);
  console.log("");

  printReports(reports);
}

async function live(): Promise<void> {
  await assertReachable();

  // Idempotent: upserts the HD-derived wallets so they appear below even on a
  // database that has never been started.
  const wallets = initializeWallets();
  const reports = await getHolderReports();

  console.log(
    `${wallets.length} derived wallet(s) seeded for ${config.network} (chainId ${config.chainId})`,
  );
  console.log("");

  printReports(reports);
}

async function main(): Promise<void> {
  if (flag("offline")) {
    await offline();
    return;
  }

  await live();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
