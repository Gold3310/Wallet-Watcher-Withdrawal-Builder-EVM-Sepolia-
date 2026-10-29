/**
 * Derive one wallet from WALLET_MNEMONIC and save its private key locally.
 *
 *     npm run wallet:derive -- --index 5
 *     npm run wallet:derive -- --index 5 --out keys/wallet-5.json
 *
 * The mnemonic is read from the environment (your `.env`), never from an
 * argument, so it does not land in shell history or `ps` output.
 *
 * WHAT THIS CANNOT DO, and it matters that this is said up front:
 *
 *   You cannot derive a wallet from an address. Derivation runs
 *   mnemonic -> private key -> address, one direction only. Recovering a
 *   private key from an address is exactly what public-key cryptography makes
 *   infeasible. So "derive a wallet from 0x…" is not a thing this or any tool
 *   can do — not for the contract deployer, not for a previous owner, not for
 *   any address you hold but do not have the seed for.
 *
 *   What it CAN do is derive the *next* wallet from a mnemonic you already
 *   hold — which is a brand new address, holding nothing.
 *
 * THAT NEW WALLET STARTS AT ZERO. It gives you access to nothing that exists
 * today. If a balance sits at some other address, the only key that can move it
 * is the one for that address. Deriving a fresh wallet does not reach it.
 *
 * Output: a JSON file, mode 0600, in a 0700 directory, under a path .gitignore
 * covers. The private key is never printed — anything printed ends up in
 * scrollback, CI logs and shell history.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import {
  buildWalletKeyFile,
  writeWalletKeyFile,
} from "../src/domain/wallet/keyfile.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const rawIndex = arg("index");

if (rawIndex === undefined) {
  console.error(
    "Usage: npm run wallet:derive -- --index <n> [--out <path>]\n\n" +
      "Derives wallet <n> from the mnemonic in your .env and saves its key to\n" +
      "keys/wallet-<n>.json (mode 0600, gitignored). Prints the address only.\n\n" +
      "NOTE: this creates a NEW address with a ZERO balance. It cannot derive a\n" +
      "wallet from an address, and it grants no access to funds held elsewhere.",
  );
  process.exit(1);
}

const index = Number(rawIndex);

if (!Number.isInteger(index) || index < 0) {
  console.error(`--index must be a non-negative integer (got: ${rawIndex})`);
  process.exit(1);
}

const mnemonic = process.env.WALLET_MNEMONIC;

if (!mnemonic || !mnemonic.trim()) {
  console.error(
    "WALLET_MNEMONIC is not set. Put it in your .env — this script reads it " +
      "from the environment so it never appears in shell history.",
  );
  process.exit(1);
}

const gitignorePath = path.resolve(process.cwd(), ".gitignore");

if (!existsSync(gitignorePath)) {
  console.error(
    "No .gitignore found. Refusing to write a private key in a repo with no " +
      "ignore rules — create one containing 'keys/' first.",
  );
  process.exit(1);
}

const outPath = arg("out") ?? path.join("keys", `wallet-${index}.json`);

try {
  // Inside the try on purpose: if the seed is an address or a raw key, the
  // explanation is the useful output, not a stack trace.
  const keyFile = buildWalletKeyFile(mnemonic.trim(), index);

  writeWalletKeyFile(path.resolve(outPath), keyFile, {
    gitignoreText: readFileSync(gitignorePath, "utf8"),
  });

  console.log(`Derived wallet ${index}`);
  console.log(`  address:     ${keyFile.address}`);
  console.log(`  path:        ${keyFile.path}`);
  console.log(`  private key: ${path.resolve(outPath)}  (0600, gitignored)`);
  console.log("");
  console.log("The private key is in that file. It was not printed on purpose:");
  console.log("terminal output ends up in scrollback, logs and shell history.");
  console.log("");
  console.log("This address holds nothing yet. It is new.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const walletCount = Number(process.env.WALLET_COUNT ?? "5");

if (index >= walletCount) {
  console.log("");
  console.log(
    `WALLET_COUNT is ${walletCount}, so the service will not sign for index ` +
      `${index}. Raise WALLET_COUNT above ${index} if you want it managed.`,
  );
}
