import { config } from "../../config/index.js";
import { getProvider } from "../../infra/rpc/provider.js";
import {
  deriveWalletAtIndex,
  getDerivationPath,
} from "./derivation.js";

export interface DerivedWallet {
  index: number;
  address: string;
  path: string;
}

// Re-exported so existing callers keep working: derivation itself lives in
// derivation.js, which needs no config and no network.
export { deriveWalletAtIndex, getDerivationPath } from "./derivation.js";

export function deriveWallets(
  mnemonic: string,
  count: number,
): DerivedWallet[] {
  const wallets: DerivedWallet[] = [];

  for (let index = 0; index < count; index += 1) {
    const wallet = deriveWalletAtIndex(mnemonic, index);
    wallets.push({
      index,
      address: wallet.address,
      path: getDerivationPath(index),
    });
  }

  return wallets;
}

export function deriveConfiguredWallets(): DerivedWallet[] {
  return deriveWallets(config.walletMnemonic, config.walletCount);
}

export function getSignerForIndex(index: number) {
  if (index < 0 || index >= config.walletCount) {
    throw new Error(
      `Wallet index must be between 0 and ${config.walletCount - 1}`,
    );
  }

  return deriveWalletAtIndex(config.walletMnemonic, index).connect(
    getProvider(),
  );
}
