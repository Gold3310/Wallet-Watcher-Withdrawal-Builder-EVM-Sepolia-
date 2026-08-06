import { describe, expect, it } from "vitest";
import {
  deriveWalletAtIndex,
  deriveWallets,
  getDerivationPath,
} from "../src/domain/wallet/wallet.service.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

describe("wallet generation", () => {
  it("derives deterministic addresses for the same index", () => {
    const first = deriveWalletAtIndex(TEST_MNEMONIC, 0);
    const second = deriveWalletAtIndex(TEST_MNEMONIC, 0);

    expect(first.address).toBe(second.address);
    expect(getDerivationPath(0)).toBe("m/44'/60'/0'/0/0");
  });

  it("produces index-ordered wallets", () => {
    const wallets = deriveWallets(TEST_MNEMONIC, 5);

    expect(wallets).toHaveLength(5);
    expect(wallets.map((wallet) => wallet.index)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(wallets.map((wallet) => wallet.address)).size).toBe(5);
  });

  it("extends wallet lists without changing earlier entries", () => {
    const five = deriveWallets(TEST_MNEMONIC, 5);
    const eight = deriveWallets(TEST_MNEMONIC, 8);

    expect(eight.slice(0, 5)).toEqual(five);
    expect(eight).toHaveLength(8);
  });

  it("supports reducing N to a subset of the original wallets", () => {
    const eight = deriveWallets(TEST_MNEMONIC, 8);
    const three = deriveWallets(TEST_MNEMONIC, 3);

    expect(three).toEqual(eight.slice(0, 3));
  });
});
