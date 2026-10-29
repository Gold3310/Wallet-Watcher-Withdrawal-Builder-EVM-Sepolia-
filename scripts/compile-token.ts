/**
 * Compiles contracts/WatcherWeth.sol into artifacts/WatcherWeth.json.
 *
 *     npm run token:compile
 *
 * The result is committed so that deploying needs no compiler. This script is
 * how you regenerate it after editing the contract — run it and commit the
 * artifact alongside the source, so the two never disagree.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArtifact } from "../src/domain/token/artifact.js";

const require = createRequire(import.meta.url);
const solc = require("solc") as {
  version(): string;
  compile(input: string): string;
};

const SOURCE = path.resolve(process.cwd(), "contracts", "WatcherWeth.sol");
const OUTPUT = path.resolve(process.cwd(), "artifacts", "WatcherWeth.json");

const input = {
  language: "Solidity",
  sources: { "WatcherWeth.sol": { content: readFileSync(SOURCE, "utf8") } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: { severity: string; formattedMessage: string }[];
  contracts?: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
};

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
const warnings = (output.errors ?? []).filter((e) => e.severity === "warning");

for (const warning of warnings) {
  console.warn(`warning: ${warning.formattedMessage.trim()}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error.formattedMessage.trim());
  }
  process.exit(1);
}

const compiled = output.contracts?.["WatcherWeth.sol"]?.WatcherWeth;

if (!compiled) {
  console.error("Compilation produced no WatcherWeth contract.");
  process.exit(1);
}

const bytecode = `0x${compiled.evm.bytecode.object}`;

// Validate through the same parser the deploy path uses, so a broken artifact
// fails here rather than at deploy time.
const artifact = parseArtifact(
  JSON.stringify(
    { contractName: "WatcherWeth", abi: compiled.abi, bytecode },
    null,
    2,
  ),
);

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(
  OUTPUT,
  `${JSON.stringify({ ...artifact, bytecode: artifact.bytecode }, null, 2)}\n`,
);

console.log(`solc ${solc.version()}`);
console.log(`wrote ${path.relative(process.cwd(), OUTPUT)}`);
console.log(`bytecode: ${(artifact.bytecode.length - 2) / 2} bytes`);
console.log(
  `functions: ${compiled.abi
    .filter((entry) => (entry as { type: string }).type === "function")
    .map((entry) => (entry as { name: string }).name)
    .sort()
    .join(", ")}`,
);
