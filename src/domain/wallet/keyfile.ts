/**
 * Deriving one wallet and saving its private key to disk.
 *
 * Two things this module is careful about, because both are easy to get wrong
 * and expensive to get wrong:
 *
 * 1. **A key file must never be committable.** `writeWalletKeyFile` refuses to
 *    write anywhere that `.gitignore` does not already cover. A leaked key is
 *    not a bug you can patch — it is the funds, gone.
 * 2. **The key is written to a file, never to a terminal.** Anything printed
 *    lands in scrollback, CI logs and shell history. The CLI prints the address
 *    and nothing else.
 *
 * What derivation cannot do, stated plainly so nobody builds on a
 * misunderstanding: it runs mnemonic -> key -> address, in that direction only.
 * You cannot derive a wallet *from an address*. An address is a hash of a public
 * key, and recovering the private key from it is precisely what public-key
 * cryptography makes infeasible. If you do not hold the seed that produced an
 * address, no tool — this one included — can produce a key for it.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveWalletAtIndex, getDerivationPath } from "./derivation.js";

export interface WalletKeyFile {
  index: number;
  /** BIP-44 path the key was derived at. */
  path: string;
  address: string;
  privateKey: string;
  warning: string;
}

/**
 * Rejects the two things people reach for by mistake, with an explanation
 * rather than a stack trace.
 *
 * Both mistakes come from the same inversion. Derivation runs
 * mnemonic -> private key -> address. An address is the OUTPUT of that chain,
 * never an input to it, and a private key is a leaf — it controls one address
 * and derives nothing further.
 */
export function assertUsableAsSeed(raw: string): void {
  const value = raw.trim();

  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      `${value} is an ADDRESS, not a mnemonic.\n\n` +
        "Addresses are the output of derivation, never the input: mnemonic -> " +
        "private key -> address runs one direction only, and recovering a key " +
        "from an address is exactly what public-key cryptography makes " +
        "infeasible.\n\n" +
        "If that address is a contract, there is no private key for it at all — " +
        "contracts are controlled by their code, not by a key, so there is " +
        "nothing to derive even in principle.\n\n" +
        "If it is a wallet you control, what you need is the mnemonic or private " +
        "key that created it. Neither can be recovered from the address alone.",
    );
  }

  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      "That is a 32-byte private key, not a BIP-39 mnemonic.\n\n" +
        "A private key is a leaf: it controls exactly one address and derives " +
        "nothing beyond it. To derive a family of wallets you need the seed — " +
        "the 12 or 24 words — that generated them.",
    );
  }
}

export function buildWalletKeyFile(
  mnemonic: string,
  index: number,
): WalletKeyFile {
  assertUsableAsSeed(mnemonic);

  const wallet = deriveWalletAtIndex(mnemonic, index);

  return {
    index,
    path: getDerivationPath(index),
    address: wallet.address,
    privateKey: wallet.privateKey,
    warning:
      "PRIVATE KEY. Anyone holding this file controls every asset at this " +
      "address, forever. Never commit it, never share it, never paste it " +
      "into a chat. Back it up somewhere other than this machine.",
  };
}

/**
 * Loose `.gitignore` coverage check: enough to catch the mistake that matters
 * (writing a key somewhere a `git add -A` would pick it up) without
 * reimplementing git's full ignore rules.
 */
export function isPathGitIgnored(
  relativePath: string,
  gitignoreText: string,
): boolean {
  const normalized = relativePath.split(path.sep).join("/");

  return gitignoreText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .some((pattern) => {
      const cleaned = pattern.replace(/^\//, "").replace(/\/$/, "");
      if (cleaned === "") {
        return false;
      }
      return (
        normalized === cleaned || normalized.startsWith(`${cleaned}/`)
      );
    });
}

export interface WriteKeyFileOptions {
  /** Contents of the repository `.gitignore`. */
  gitignoreText: string;
  /**
   * Path to test for ignore coverage. Defaults to `filePath` relative to the
   * cwd, which is what you want when writing into the repo.
   */
  ignoreCheckPath?: string;
}

export function writeWalletKeyFile(
  filePath: string,
  keyFile: WalletKeyFile,
  options: WriteKeyFileOptions,
): void {
  const checkPath =
    options.ignoreCheckPath ?? path.relative(process.cwd(), filePath);

  if (!isPathGitIgnored(checkPath, options.gitignoreText)) {
    throw new Error(
      `Refusing to write ${filePath}: it is not covered by .gitignore. ` +
        `Add its directory to .gitignore first — a key file must never be ` +
        `possible to commit.`,
    );
  }

  if (existsSync(filePath)) {
    throw new Error(
      `${filePath} already exists. Refusing to overwrite a key file: if the ` +
        `old key is still in use, overwriting it destroys access. Move it ` +
        `aside deliberately, or pick another --out path.`,
    );
  }

  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(keyFile, null, 2)}\n`, {
    mode: 0o600,
  });

  // mkdirSync's mode is umask-dependent, so verify rather than assume.
  const mode = statSync(filePath).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${filePath} was written with mode ${mode.toString(8)}, expected 600. ` +
        `Tighten your umask and try again.`,
    );
  }
}
