#!/usr/bin/env tsx
/**
 * Find every ABT holder by scanning Transfer and Deposit logs, then asking the
 * contract what each of them holds right now.
 *
 * The contract cannot list its holders, but the accounts are recoverable from
 * logs and the balances are readable from `balanceOf`. Enumerate from logs,
 * read balances live — not one or the other.
 *
 * `--offline` replays a recorded history, so the whole thing is demonstrable
 * without pointing at a chain.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import { formatUnits } from "ethers";
import { config } from "../src/config/index.js";
import {
  parseFixture,
  fixtureProvider,
} from "../src/domain/assets/fixture.js";
import { scanHolders } from "../src/domain/assets/holder.scan.js";
import type { HolderScanProvider } from "../src/domain/assets/holder.scan.js";
import { assertReachable, getProvider } from "../src/infra/rpc/provider.js";

const DEFAULT_FIXTURE = path.join(
  process.cwd(),
  "fixtures",
  "holder-snapshot.json",
);
const DECIMALS = 18;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function print(
  label: string,
  result: Awaited<ReturnType<typeof scanHolders>>,
  recorded: boolean,
): void {
  console.log(label);
  console.log(`contract:   ${result.contract}`);
  console.log(
    `blocks:     ${result.fromBlock} → ${result.toBlock} (${result.blocksScanned} scanned)`,
  );
  console.log(`candidates: ${result.candidates} address(es) ever received ABT`);
  console.log(
    `holders:    ${result.holders.length} with a non-zero balance now`,
  );
  if (result.unreadable.length > 0) {
    console.log(
      `unreadable: ${result.unreadable.length} candidate(s) whose balance could not be read`,
    );
    for (const address of result.unreadable) {
      console.log(`            ${address}`);
    }
  }
  if (result.totalSupply !== null) {
    console.log(`supply:     ${formatUnits(result.totalSupply, DECIMALS)}`);
  }
  console.log("");

  for (const holder of result.holders) {
    const amount = formatUnits(holder.balance, DECIMALS);
    const share =
      result.totalSupply !== null && result.totalSupply > 0n
        ? ((Number(holder.balance) / Number(result.totalSupply)) * 100).toFixed(
            4,
          )
        : "?";
    console.log(
      `  ${holder.address}  ${amount.padStart(10)}  ${share.padStart(8)}%`,
    );
  }

  if (recorded) {
    console.log("");
    console.log(
      "Balances read through the same balanceOf path a live scan uses; the",
    );
    console.log(
      "log history is a reconstruction standing in for a real log scan.",
    );
  }
}

async function offline(): Promise<void> {
  const fixturePath = arg("fixture") ?? DEFAULT_FIXTURE;
  const fixture = parseFixture(readFileSync(fixturePath, "utf8"));

  if (
    !config.trackedContracts.some(
      (address) => address.toLowerCase() === fixture.contract.toLowerCase(),
    )
  ) {
    throw new Error(
      `Fixture describes ${fixture.contract}, which is not in TRACKED_CONTRACT for this environment`,
    );
  }

  const result = await scanHolders(
    fixtureProvider(fixture) as unknown as HolderScanProvider,
    fixture.contract,
    {
      fromBlock: fixture.deploymentBlock ?? 0,
      toBlock: numberArg("to-block") ?? 20_000_999,
      chunkSize: numberArg("chunk"),
    },
  );

  if (has("json")) {
    console.log(
      JSON.stringify(
        {
          ...result,
          holders: result.holders.map((h) => ({
            address: h.address,
            balance: h.balance.toString(),
          })),
          totalSupply: result.totalSupply?.toString() ?? null,
          unreadable: result.unreadable,
        },
        null,
        2,
      ),
    );
    return;
  }

  print("OFFLINE — RECONSTRUCTED LOG HISTORY, NOT A LIVE SCAN", result, true);
}

async function live(): Promise<void> {
  await assertReachable();
  const provider = getProvider() as unknown as HolderScanProvider & {
    getBlockNumber(): Promise<number>;
  };

  const fromBlock = numberArg("from-block");
  if (fromBlock === undefined) {
    throw new Error(
      "--from-block is required for a live scan: the deployment block, or any " +
        "block you want to start from. Mainnet is far too long to scan from 0.",
    );
  }

  const head = await provider.getBlockNumber();
  const result = await scanHolders(provider, config.trackedContracts[0], {
    fromBlock,
    toBlock: numberArg("to-block") ?? head,
    chunkSize: numberArg("chunk"),
  });

  if (has("json")) {
    console.log(
      JSON.stringify(
        {
          ...result,
          holders: result.holders.map((h) => ({
            address: h.address,
            balance: h.balance.toString(),
          })),
          totalSupply: result.totalSupply?.toString() ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  print(`LIVE — ${config.network} (chainId ${config.chainId})`, result, false);
}

async function main(): Promise<void> {
  if (has("offline")) {
    await offline();
    return;
  }
  await live();
}

main().catch((error: unknown) => {
  console.error(`Scan failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
