#!/usr/bin/env tsx
/**
 * Plan a withdrawal from a named address — and say whether it can be signed
 * here or has to be signed by whoever holds that address.
 *
 * Nothing is broadcast. Nothing is signed. This produces the transaction and
 * the route, then stops.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import { formatUnits, parseUnits } from "ethers";
import { config } from "../src/config/index.js";
import { parseFixture, fixtureProvider } from "../src/domain/assets/fixture.js";
import { planWithdrawal } from "../src/domain/assets/withdraw.plan.js";
import type { WithdrawalPlan } from "../src/domain/assets/withdraw.plan.js";
import { assertReachable, getProvider } from "../src/infra/rpc/provider.js";

const DECIMALS = 18;
const DEFAULT_FIXTURE = path.join(
  process.cwd(),
  "fixtures",
  "holder-snapshot.json",
);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function print(plan: WithdrawalPlan, label: string): void {
  console.log(label);
  console.log("");
  console.log(`from:       ${plan.from}`);
  console.log(`contract:   ${plan.contract}`);
  console.log(`amount:     ${formatUnits(plan.amountWei, DECIMALS)} ABT (${plan.amountWei} units)`);
  console.log(
    `balance:    ${
      plan.balance === null ? "unknown (could not be read)" : formatUnits(plan.balance, DECIMALS)
    }`,
  );
  console.log(
    `sufficient: ${
      plan.sufficient === null ? "unknown" : plan.sufficient ? "yes" : "NO"
    }`,
  );
  console.log(`can sign here: ${plan.canSignHere ? "yes" : "NO"}`);
  console.log(`route:      ${plan.route}`);

  if (plan.blockers.length > 0) {
    console.log("");
    console.log("BLOCKERS");
    for (const blocker of plan.blockers) {
      console.log(`  ${blocker.replace(/(.{72}\s)/g, "$1  ")}`);
    }
  }

  console.log("");
  console.log("TRANSACTION (unsigned — nothing has been signed or sent)");
  console.log(`  to:    ${plan.transaction.to}`);
  console.log(`  data:  ${plan.transaction.data}`);
  console.log(`  value: ${plan.transaction.value}`);
  console.log(`  chain: ${plan.transaction.chainId}`);

  console.log("");
  console.log("WHAT TO DO");
  plan.instructions.forEach((step, index) => {
    console.log(`  ${index + 1}. ${step.replace(/(.{70}\s)/g, "$1     ")}`);
  });
}

async function main(): Promise<void> {
  const from = arg("from");
  const amountRaw = arg("amount");

  if (from === undefined || amountRaw === undefined) {
    console.error("Usage: npm run withdraw:plan -- --from <address> --amount <amount> [--wei] [--chain-id N] [--offline] [--json]");
    process.exitCode = 1;
    return;
  }

  const amountWei = has("wei")
    ? amountRaw
    : parseUnits(amountRaw, DECIMALS).toString();

  const chainId = arg("chain-id") === undefined
    ? undefined
    : Number(arg("chain-id"));

  const contract = config.trackedContracts[0];

  const plan = has("offline")
    ? await planWithdrawal(
        fixtureProvider(parseFixture(readFileSync(arg("fixture") ?? DEFAULT_FIXTURE, "utf8"))) as never,
        contract,
        { from, amountWei, ...(chainId === undefined ? {} : { chainId }) },
      )
    : await (async () => {
        await assertReachable();
        return planWithdrawal(getProvider() as never, contract, {
          from,
          amountWei,
          ...(chainId === undefined ? {} : { chainId }),
        });
      })();

  if (has("json")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  print(
    plan,
    has("offline")
      ? "OFFLINE — BALANCE FROM RECORDED DATA, NOT A LIVE READ"
      : `LIVE — ${config.network} (chainId ${config.chainId})`,
  );
}

main().catch((error: unknown) => {
  console.error(`Plan failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
