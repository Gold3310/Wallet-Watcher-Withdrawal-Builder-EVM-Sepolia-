/**
 * Check a decoded Aragon EVMScript payload against its own bytes.
 *
 *   npm run verify:evmscript -- --in <decoded.json> [--sig "fn(type,…)"]… [--role NAME]… [--out <report.json>]
 *
 * The input is a decoder's JSON: one call or an array of them, each with
 * contractAddress, functionName, selector, args and optional nestedCalls.
 * Nested calls are re-derived from the raw script in the parent's arguments,
 * never trusted from the decoder's list.
 *
 * Offline and read-only: no RPC, no keys, nothing signed or sent. Exits
 * non-zero unless every call verifies.
 */
import fs from "node:fs";
import {
  CallVerification,
  loadDecodedCalls,
  verifyDecodedCalls,
} from "../src/domain/governance/verify-decoded.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function args(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    const next = process.argv[index + 1];
    if (value === `--${name}` && next !== undefined) {
      values.push(next);
    }
  });
  return values;
}

const inputPath = arg("in");
const outputPath = arg("out");

if (!inputPath || inputPath.startsWith("--")) {
  console.error(
    'Usage: npm run verify:evmscript -- --in <decoded.json> [--sig "fn(type,...)"]... [--role NAME]... [--out <report.json>]',
  );
  process.exit(1);
}

let report;
try {
  report = verifyDecodedCalls(loadDecodedCalls(inputPath), {
    signatures: args("sig"),
    roleNames: args("role"),
  });
} catch (error) {
  console.error(`Could not verify ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const depth = (call: CallVerification) => call.path.split(".").length - 1;
const topLevel = report.calls.filter((call) => depth(call) === 0).length;

console.log(`Loaded ${inputPath}: ${topLevel} top-level call(s), ${report.calls.length - topLevel} nested`);
console.log("");
console.log(`  ${"path".padEnd(8)} ${"status".padEnd(11)} ${"signature".padEnd(34)} ${"target".padEnd(42)}  label (unverified)`);

for (const call of report.calls) {
  const indent = "  ".repeat(depth(call));
  const signature = call.signature ?? (call.functionName ? `${call.functionName}(?)` : "(not in decoded view)");
  console.log(
    `  ${`${indent}${call.path}`.padEnd(8)} ${call.status.padEnd(11)} ${signature.padEnd(34)} ` +
      `${(call.to ?? "?").padEnd(42)}  ${call.contractName ?? ""}`,
  );
  for (const annotation of call.annotations) {
    console.log(`  ${" ".repeat(8)}   ${annotation}`);
  }
  for (const note of call.notes) {
    console.log(`  ${" ".repeat(8)}   ! ${note}`);
  }
}

console.log("");
for (const [status, count] of Object.entries(report.summary)) {
  console.log(`  ${status.padEnd(11)} ${count}`);
}

console.log("");
for (const note of report.notes) {
  console.log(note);
}

console.log("");
console.log("Not checked (needs a node, or a person):");
for (const item of report.notChecked) {
  console.log(`  - ${item}`);
}

if (outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log("");
  console.log(`Report written to ${outputPath}`);
}

console.log("");
if (!report.fullyVerified) {
  console.error("The decoded view does not fully match the bytes. See the notes marked ! above.");
  process.exit(1);
}

console.log("Every call in the decoded view matches the bytes it claims to describe.");
