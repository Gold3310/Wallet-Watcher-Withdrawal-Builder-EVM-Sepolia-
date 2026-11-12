/**
 * Process a standard-v1 Merkle snapshot from the command line.
 *
 *   npm run withdraw:snapshot -- <snapshot.json>            # dry run
 *   npm run withdraw:snapshot -- <snapshot.json> --execute  # sign + broadcast
 *   npm run withdraw:snapshot -- <snapshot.json> --execute --no-broadcast
 *
 * A plain run is a dry run: it prints every vault, its deduction breakdown and
 * the amount that would be paid, and signs nothing. Signing requires `--execute`,
 * and sending requires `--execute` without `--no-broadcast`. Broadcasts require
 * `--idempotency-key` as a second speed bump, mirroring the API.
 *
 * Every run writes an evidence row to `data/snapshots/<refSlot>-<blockNumber>.json`
 * (override with `--out <path>`): the block it was taken from, every deduction,
 * and what was sent. A payout is only checkable after the fact if the tree that
 * justified it is on disk somewhere.
 *
 * Exit codes: 0 success, 1 bad input / failed withdrawals, 2 usage error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import { config } from "../src/config/index.js";
import { closeDatabase, getAllWallets } from "../src/infra/db/database.js";
import {
  processStandardV1Snapshot,
  StandardV1Snapshot,
} from "../src/domain/withdrawal/merkle.integration.js";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const inputPath = process.argv[2];

if (!inputPath || inputPath.startsWith("--")) {
  console.error(
    "Usage: npm run withdraw:snapshot -- <snapshot.json> [--execute] [--no-broadcast] [--idempotency-key <key>]",
  );
  process.exit(2);
}

const execute = flag("execute");
const broadcast = execute && !flag("no-broadcast");

if (broadcast && !arg("idempotency-key")) {
  console.error(
    "Refusing to broadcast without --idempotency-key: a retry must not pay twice.",
  );
  process.exit(2);
}

let snapshot: StandardV1Snapshot;
try {
  snapshot = JSON.parse(
    readFileSync(path.resolve(process.cwd(), inputPath), "utf8"),
  ) as StandardV1Snapshot;
} catch (error) {
  console.error(
    `Could not read snapshot at ${inputPath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const wallets = initializeWallets();
  console.log(
    `Network: ${config.network} (chainId ${config.chainId}) — ${wallets.length} derived wallet(s)`,
  );
  console.log(
    `Mode: ${execute ? (broadcast ? "EXECUTE + BROADCAST" : "EXECUTE (build only)") : "DRY RUN (nothing signed)"}`,
  );

  const run = await processStandardV1Snapshot(snapshot, {
    execute,
    broadcast,
    actor: `cli:${arg("idempotency-key") ?? "dry-run"}`,
  });

  console.log(
    `\nSnapshot ${run.refSlot}\n  block ${run.block.blockNumber} ${run.block.blockHash}\n  as of ${new Date(run.block.timestamp * 1000).toISOString()}`,
  );

  const derived = new Map(
    getAllWallets().map((wallet) => [wallet.address.toLowerCase(), wallet.index]),
  );

  console.log(`\n${"vault".padEnd(44)} ${"wallet".padEnd(20)} ${"net ETH".padStart(14)}`);
  console.log("-".repeat(80));

  for (const breakdown of run.breakdowns) {
    const walletIndex = derived.get(breakdown.address.toLowerCase());
    const skipped = run.skipped.find((leaf) => leaf.address === breakdown.address);
    const tag = skipped ? `skip: ${skipped.reason}` : `#${walletIndex}`;

    console.log(
      `${breakdown.address.padEnd(44)} ${tag.padEnd(20)} ${weiToEth(breakdown.netAmountWei).padStart(14)}`,
    );
  }

  console.log("-".repeat(80));
  console.log(
    `${"total".padEnd(44)} ${`${run.entries.length} payable`.padEnd(20)} ${run.totalNetEth.padStart(14)}`,
  );

  if (run.skipped.length > 0) {
    console.log("\nSkipped vaults:");
    for (const leaf of run.skipped) {
      console.log(`  ${leaf.address} — ${leaf.reason}: ${leaf.detail}`);
    }
  }

  const evidencePath = writeEvidence(run);
  console.log(`\nEvidence row: ${path.relative(process.cwd(), evidencePath)}`);

  if (!execute) {
    console.log("\nDry run: nothing was signed. Re-run with --execute to build transactions.");
    return;
  }

  let failed = 0;

  console.log("\nResults:");
  for (const result of run.results) {
    if (result.status === "failed") {
      failed += 1;
      console.log(`  FAILED  ${result.address}: ${result.error}`);
      continue;
    }

    console.log(
      `  ${result.status === "broadcast" ? "SENT   " : "BUILT  "} ${result.address} ` +
        `${weiToEth(result.result.built.value)} ETH ` +
        `hash=${result.result.built.hash}` +
        (broadcast ? ` tx=${result.result.txHash}` : ""),
    );
  }

  if (failed > 0) {
    throw new Error(`${failed} of ${run.results.length} withdrawal(s) failed`);
  }
}

function writeEvidence(run: Awaited<ReturnType<typeof processStandardV1Snapshot>>): string {
  const target =
    arg("out") ??
    path.join(
      "data",
      "snapshots",
      `${run.refSlot.slice(0, 10)}-${run.block.blockNumber}.json`,
    );
  const absolute = path.resolve(process.cwd(), target);

  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(run.evidence, null, 2)}\n`, "utf8");

  return absolute;
}

function weiToEth(wei: string): string {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

main()
  .then(() => closeDatabase())
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    closeDatabase();
    process.exitCode = 1;
  });
