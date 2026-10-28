import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveWalletAtIndex } from "../src/domain/wallet/derivation.js";
import {
  buildWalletKeyFile,
  isPathGitIgnored,
  writeWalletKeyFile,
} from "../src/domain/wallet/keyfile.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

/** The BondToken contract — a contract, so it has no private key at all. */
const CONTRACT_ADDRESS = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
/** The deployer — an EOA whose key belongs to whoever deployed the contract. */
const CREATOR_ADDRESS = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D";

/** Enough of a .gitignore to exercise the coverage check. */
const GITIGNORE = ["node_modules/", "dist/", ".env", "keys/", "# a comment"].join(
  "\n",
);

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wallet-keys-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("deriving a wallet key file", () => {
  it("matches the wallet the service derives at the same index", () => {
    const keyFile = buildWalletKeyFile(TEST_MNEMONIC, 3);
    const wallet = deriveWalletAtIndex(TEST_MNEMONIC, 3);

    expect(keyFile.address).toBe(wallet.address);
    expect(keyFile.privateKey).toBe(wallet.privateKey);
    expect(keyFile.path).toBe("m/44'/60'/0'/0/3");
  });

  it("produces a different wallet per index", () => {
    const first = buildWalletKeyFile(TEST_MNEMONIC, 0);
    const second = buildWalletKeyFile(TEST_MNEMONIC, 1);

    expect(first.address).not.toBe(second.address);
    expect(first.privateKey).not.toBe(second.privateKey);
  });

  it("carries a warning about what the key is", () => {
    const keyFile = buildWalletKeyFile(TEST_MNEMONIC, 0);
    expect(keyFile.warning).toMatch(/Never commit it/);
  });
});

describe("rejecting things that look like seeds but are not", () => {
  it("rejects an address, and explains why", () => {
    expect(() => buildWalletKeyFile(CONTRACT_ADDRESS, 0)).toThrow(
      /is an ADDRESS, not a mnemonic/,
    );
    // The explanation is the point: a contract has no key to derive at all.
    expect(() => buildWalletKeyFile(CONTRACT_ADDRESS, 0)).toThrow(
      /contracts are controlled by their code/,
    );
  });

  it("rejects every address shape, not just the tracked contract", () => {
    expect(() => buildWalletKeyFile(CREATOR_ADDRESS, 0)).toThrow(
      /is an ADDRESS, not a mnemonic/,
    );
    expect(() =>
      buildWalletKeyFile("0x2ddfbeca5b62f310a5f8edefb4fc026a99b979ce", 0),
    ).toThrow(/is an ADDRESS, not a mnemonic/);
  });

  it("rejects a raw private key", () => {
    const key = "11".repeat(32);
    expect(() => buildWalletKeyFile(key, 0)).toThrow(
      /private key, not a BIP-39 mnemonic/,
    );
    expect(() => buildWalletKeyFile(`0x${key}`, 0)).toThrow(
      /private key, not a BIP-39 mnemonic/,
    );
  });

  it("accepts a real mnemonic", () => {
    expect(() => buildWalletKeyFile(TEST_MNEMONIC, 0)).not.toThrow();
  });
});

describe("gitignore coverage", () => {
  it("recognises an ignored path", () => {
    expect(isPathGitIgnored("keys/wallet-0.json", GITIGNORE)).toBe(true);
    expect(isPathGitIgnored("keys/nested/wallet-0.json", GITIGNORE)).toBe(true);
    expect(isPathGitIgnored("node_modules/x", GITIGNORE)).toBe(true);
  });

  it("rejects a path nothing covers", () => {
    expect(isPathGitIgnored("src/wallet-0.json", GITIGNORE)).toBe(false);
    expect(isPathGitIgnored("wallet-0.json", GITIGNORE)).toBe(false);
  });
});

describe("writing the key file", () => {
  it("writes readable by owner only", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "wallet-0.json");

    writeWalletKeyFile(
      filePath,
      buildWalletKeyFile(TEST_MNEMONIC, 0),
      { gitignoreText: GITIGNORE, ignoreCheckPath: "keys/wallet-0.json" },
    );

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    expect(written.address).toBe(deriveWalletAtIndex(TEST_MNEMONIC, 0).address);
  });

  it("refuses to write where git would pick the file up", () => {
    const dir = tempDir();

    expect(() =>
      writeWalletKeyFile(
        path.join(dir, "wallet-0.json"),
        buildWalletKeyFile(TEST_MNEMONIC, 0),
        { gitignoreText: GITIGNORE, ignoreCheckPath: "src/wallet-0.json" },
      ),
    ).toThrow(/not covered by \.gitignore/);
  });

  it("refuses to overwrite an existing key", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "wallet-0.json");
    writeFileSync(filePath, "old");

    expect(() =>
      writeWalletKeyFile(
        filePath,
        buildWalletKeyFile(TEST_MNEMONIC, 0),
        { gitignoreText: GITIGNORE, ignoreCheckPath: "keys/wallet-0.json" },
      ),
    ).toThrow(/already exists/);
  });
});
