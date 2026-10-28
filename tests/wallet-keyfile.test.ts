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
