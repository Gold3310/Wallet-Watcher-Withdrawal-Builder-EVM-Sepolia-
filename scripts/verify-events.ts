/**
 * Verify the evidence file against a chain.
 *
 *   npm run verify:events -- <RPC_URL>
 *   npm run verify:events -- <RPC_URL> --in evidence/erc20-transfer-events.json \
 *     --out evidence/erc20-transfer-events.verified.json
 *
 * Read-only: it fetches receipts and compares fields. It signs and sends
 * nothing. Exits non-zero if any row failed to match.
 *
 * This was not run from the development sandbox, which has no network access —
 * the committed evidence therefore remains UNVERIFIED until you run it against
 * a node for the chain the logs came from.
 */
import fs from "node:fs";
import { JsonRpcProvider } from "ethers";
import { loadEvidence, summarize } from "../src/domain/evidence/analysis.js";
import {
  EvidenceProvider,
  isFullyVerified,
  verifyEvidence,
} from "../src/domain/evidence/verify.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const rpcUrl = process.argv[2];
const inputPath = arg("in") ?? "evidence/erc20-transfer-events.json";
const outputPath = arg("out") ?? "evidence/erc20-transfer-events.verified.json";

if (!rpcUrl || rpcUrl.startsWith("--")) {
  console.error("Usage: npm run verify:events -- <RPC_URL> [--in FILE] [--out FILE]");
  process.exit(1);
}

const dataset = loadEvidence(inputPath);
console.log(`Loaded ${dataset.rows.length} row(s) from ${inputPath}`);
console.log(`Source network field: ${dataset.network}`);

const provider = new JsonRpcProvider(rpcUrl);

const adapter: EvidenceProvider = {
  getTransactionReceipt: async (txHash) => {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return null;
    }
    return {
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
    };
  },
  getBlockNumber: () => provider.getBlockNumber(),
  getNetwork: async () => ({ chainId: Number((await provider.getNetwork()).chainId) }),
};

const report = await verifyEvidence(dataset.rows, adapter);

const summary = summarize(dataset.rows);
console.log("");
console.log(`chainId:          ${report.chainId ?? "unknown"}`);
console.log(`head:             ${report.head ?? "unknown"}`);
console.log(`block range:      ${summary.blockRange?.from} - ${summary.blockRange?.to}`);
console.log(`rows:             ${summary.rows} (${summary.complete} complete, ${summary.incomplete} incomplete)`);
console.log("");

for (const [status, count] of Object.entries(report.summary)) {
  console.log(`  ${status.padEnd(18)} ${count}`);
}

const failures = report.rows.filter(
  (row) => row.status === "MISMATCH" || row.status === "MISSING_TX" || row.status === "MISSING_LOG",
);

if (failures.length > 0) {
  console.log("");
  console.log("Rows that did not match:");
  for (const failure of failures) {
    console.log(`  ${failure.txHash} #${failure.logIndex}: ${failure.status}`);
    for (const note of failure.notes) {
      console.log(`      ${note}`);
    }
  }
}

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log("");
console.log(`Report written to ${outputPath}`);

if (!isFullyVerified(report)) {
  console.error("Verification did not complete cleanly — see the report.");
  process.exit(1);
}

console.log("All checkable rows match on-chain.");
