#!/usr/bin/env tsx
/**
 * Everything this system can do to move value, printed in one place.
 *
 * No server, no endpoint, no network. The point is that the answer to "what
 * can I withdraw, and how" should not depend on anything being online.
 */
import { buildWithdrawalCatalog } from "../src/domain/assets/withdrawals.catalog.js";
import type { WithdrawalCapability } from "../src/domain/assets/withdrawals.catalog.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const LABELS: Record<string, string> = {
  redemption: "REDEEM",
  transfer: "TRANSFER",
  wrap: "WRAP",
  approval: "APPROVE",
  administrative: "ADMIN",
  service: "SERVICE",
  inspection: "INSPECT",
  unclassified: "UNCLASSIFIED",
};

function printCapability(cap: WithdrawalCapability): void {
  console.log("");
  console.log(`${cap.id}  [${LABELS[cap.kind] ?? cap.kind}]`);
  console.log(`  ${cap.signature}`);
  if (cap.selector !== undefined) {
    console.log(`  selector: ${cap.selector}`);
  }
  console.log(`  does:     ${cap.summary.replace(/(.{72}\s)/g, "$1     ")}`);
  console.log(`  needs:    ${cap.requirement.replace(/(.{72}\s)/g, "$1     ")}`);
  if (cap.blocker !== undefined) {
    console.log(`  BLOCKED:  ${cap.blocker.replace(/(.{72}\s)/g, "$1          ")}`);
  }
  console.log(`  run:`);
  for (const line of cap.invoke.split("\n")) {
    console.log(`    ${line}`);
  }
}

function main(): void {
  const catalog = buildWithdrawalCatalog();

  if (has("json")) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }

  const id = arg("id");
  if (id !== undefined) {
    const cap = catalog.capabilities.find((entry) => entry.id === id);
    if (cap === undefined) {
      console.error(`No capability with id "${id}".`);
      console.error(`Known ids: ${catalog.capabilities.map((c) => c.id).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`WITHDRAWAL CATALOGUE — ${catalog.contract}`);
    printCapability(cap);
    return;
  }

  const byLayer = (layer: string) =>
    catalog.capabilities.filter((cap) => cap.layer === layer);

  console.log(`WITHDRAWAL CATALOGUE — ${catalog.contract}`);
  console.log(`${catalog.capabilities.length} capabilities`);

  for (const layer of ["contract", "api", "cli"]) {
    const group = byLayer(layer);
    if (group.length === 0) {
      continue;
    }
    console.log("");
    console.log(`${layer.toUpperCase()} (${group.length})`);
    for (const cap of group) {
      printCapability(cap);
    }
  }

  console.log("");
  console.log(`AVAILABLE HERE (${catalog.available.length}): ${catalog.available.join(", ")}`);
  console.log(`BLOCKED (${catalog.blocked.length}):`);
  for (const entry of catalog.blocked) {
    console.log(`  - ${entry.id}: ${entry.reason.replace(/(.{70}\s)/g, "$1    ")}`);
  }
  if (catalog.unclassified.length > 0) {
    console.log(`UNCLASSIFIED (${catalog.unclassified.length}): ${catalog.unclassified.join(", ")}`);
  }
  console.log("");
  console.log(catalog.verdict.replace(/(.{76}\s)/g, "$1"));
}

main();
