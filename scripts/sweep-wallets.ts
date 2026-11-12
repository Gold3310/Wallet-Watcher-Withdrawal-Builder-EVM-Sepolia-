/**
 * Sweep wrapped ETH, ERC-20 tokens, and remaining ETH from derived wallets to
 * one destination address.
 *
 *   npm run wallet:sweep -- --to <0xAddress>                       # plan only
 *   npm run wallet:sweep -- --to <0xAddress> --unwrap --broadcast  # unwrap + send
 *
 * Plans every wallet first and sends nothing unless --broadcast is given.
 * Guards (WITHDRAWAL_ALLOWLIST, MAINNET_MAX_TX_VALUE_WEI, velocity limits) are
 * checked across all wallets before a single transaction is submitted.
 */
import "dotenv/config";
import fs from "node:fs";
import type { SweepStepResult } from "../src/domain/sweep/sweep.service.js";

const VALUE_FLAGS = new Set(["--to", "--index", "--token", "--unwrap-token", "--out"]);
const BOOL_FLAGS = new Set(["--unwrap", "--eth-only", "--no-eth", "--broadcast", "--help", "-h"]);

const USAGE =
  "Usage: npm run wallet:sweep -- --to <0xAddress> [--index 0,1] [--token 0x...] " +
  "[--unwrap] [--unwrap-token 0x...] [--eth-only] [--no-eth] [--out <report.json>] [--broadcast]";

interface ParsedCli {
  toAddress: string;
  walletIndices?: number[];
  tokens?: string[];
  unwrap: boolean;
  unwrapContracts?: string[];
  includeNative: boolean;
  outPath?: string;
  broadcast: boolean;
}

function parseCli(argv: readonly string[]): ParsedCli {
  let toAddress: string | undefined;
  const rawIndices: string[] = [];
  const rawTokens: string[] = [];
  const rawUnwrapTokens: string[] = [];
  let unwrap = false;
  let ethOnly = false;
  let noEth = false;
  let outPath: string | undefined;
  let broadcast = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      console.log(USAGE);
      process.exit(0);
    }

    if (BOOL_FLAGS.has(token)) {
      if (token === "--unwrap") unwrap = true;
      if (token === "--eth-only") ethOnly = true;
      if (token === "--no-eth") noEth = true;
      if (token === "--broadcast") broadcast = true;
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      i += 1;

      if (token === "--to") {
        toAddress = value;
      } else if (token === "--out") {
        outPath = value;
      } else if (token === "--index") {
        rawIndices.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      } else if (token === "--token") {
        rawTokens.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      } else if (token === "--unwrap-token") {
        rawUnwrapTokens.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      }
      continue;
    }

    throw new Error(`Unknown option: ${token}\n${USAGE}`);
  }

  if (!toAddress) {
    throw new Error(`--to is required.\n${USAGE}`);
  }

  if (ethOnly && noEth) {
    throw new Error("Nothing to sweep: --eth-only and --no-eth cannot both be set.");
  }

  if (ethOnly && (rawTokens.length > 0 || rawUnwrapTokens.length > 0 || unwrap)) {
    throw new Error("--eth-only cannot be combined with --token, --unwrap, or --unwrap-token.");
  }

  let walletIndices: number[] | undefined;
  if (rawIndices.length > 0) {
    walletIndices = rawIndices.map((raw) => {
      if (!/^\d+$/.test(raw)) {
        throw new Error(`Invalid wallet index "${raw}": expected a non-negative integer`);
      }
      return Number(raw);
    });
  }

  return {
    toAddress,
    ...(walletIndices !== undefined ? { walletIndices } : {}),
    ...(ethOnly ? { tokens: [] } : rawTokens.length > 0 ? { tokens: rawTokens } : {}),
    unwrap,
    ...(rawUnwrapTokens.length > 0 ? { unwrapContracts: rawUnwrapTokens } : {}),
    includeNative: !noEth,
    ...(outPath !== undefined ? { outPath } : {}),
    broadcast,
  };
}

function formatStepAmount(step: SweepStepResult): string {
  const unit = step.symbol ?? (step.contract ? step.contract.slice(0, 10) : "raw");
  const value = step.amountFormatted ?? step.amountRaw;
  const est = step.estimatedAfterPriorSteps ? " (est)" : "";
  return `${value} ${unit}${est}`;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));

  const [{ initializeWallets }, { createSweep }, { assertReachable }] =
    await Promise.all([
      import("../src/domain/balance/balance.service.js"),
      import("../src/domain/sweep/sweep.service.js"),
      import("../src/infra/rpc/provider.js"),
    ]);

  await assertReachable();
  initializeWallets();

  const report = await createSweep({
    toAddress: cli.toAddress,
    ...(cli.walletIndices !== undefined ? { walletIndices: cli.walletIndices } : {}),
    ...(cli.tokens !== undefined ? { tokens: cli.tokens } : {}),
    unwrap: cli.unwrap,
    ...(cli.unwrapContracts !== undefined ? { unwrapContracts: cli.unwrapContracts } : {}),
    includeNative: cli.includeNative,
    broadcast: cli.broadcast,
  });

  console.log(
    `Wallet sweep${report.broadcast ? "" : " (planned)"} on ${report.network} (chainId ${report.chainId})`,
  );
  console.log(`  to:      ${report.toAddress}`);
  console.log(`  relayer: ${report.relayer}`);
  console.log("");

  for (const wallet of report.wallets) {
    console.log(
      `Wallet #${wallet.index}  ${wallet.address}  [${wallet.status.toUpperCase()}]  native ${wallet.nativeEthBefore} ETH`,
    );
    if (wallet.reason) {
      console.log(`  ${wallet.reason}`);
    }
    for (const step of wallet.steps) {
      const target = step.contract ? `${step.kind} (${step.contract})` : step.kind;
      const hash = step.txHash ? `  tx ${step.txHash}` : "";
      console.log(
        `  - ${step.status.toUpperCase().padEnd(10)} ${target.padEnd(50)} ${formatStepAmount(step)}${hash}`,
      );
      if (step.reason) {
        console.log(`               ${step.reason}`);
      }
    }
  }

  console.log("");
  console.log("Summary:");
  console.log(`  wallets scanned:     ${report.summary.walletsScanned}`);
  console.log(`  wallets with moves:  ${report.summary.walletsWithActions}`);
  console.log(
    `  steps:               ready=${report.summary.stepsReady} broadcast=${report.summary.stepsBroadcast} skipped=${report.summary.stepsSkipped} blocked=${report.summary.stepsBlocked} failed=${report.summary.stepsFailed}`,
  );
  console.log(
    `  ETH ${report.broadcast ? "sent" : "planned"}:          ${report.summary.totalEthFormatted} ETH (${report.summary.totalEthWei} wei)`,
  );

  for (const token of report.summary.tokenTotals) {
    const label = token.symbol ?? token.contract;
    if (BigInt(token.unwrapRaw) > 0n) {
      console.log(
        `  unwrap ${label}:       ${token.unwrapFormatted ?? token.unwrapRaw}`,
      );
    }
    if (BigInt(token.transferRaw) > 0n) {
      console.log(
        `  transfer ${label}:     ${token.transferFormatted ?? token.transferRaw}`,
      );
    }
  }

  if (report.notes.length > 0) {
    console.log("");
    for (const note of report.notes) {
      console.log(`Note: ${note}`);
    }
  }

  if (cli.outPath) {
    fs.writeFileSync(cli.outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log("");
    console.log(`Report written to ${cli.outPath}`);
  }

  console.log("");
  if (!report.broadcast) {
    if (report.summary.stepsReady > 0) {
      console.log("Nothing was sent. Add --broadcast to execute the ready steps above.");
    } else {
      console.log("Nothing was sent, and no ready steps were found.");
    }
  } else if (report.summary.stepsFailed > 0) {
    console.error("One or more sweep transactions failed. Inspect the report above before retrying.");
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (message.includes("allowlist")) {
    console.error(
      "Hint: add the destination address to WITHDRAWAL_ALLOWLIST in your .env (or clear it to allow any destination).",
    );
  }
  process.exit(1);
});
