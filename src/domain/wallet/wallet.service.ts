import { HDNodeWallet, Mnemonic } from "ethers";
import { config, DERIVATION_PATH_PREFIX } from "../../config/index.js";
import { getProvider } from "../../infra/rpc/provider.js";

export interface DerivedWallet {
  index: number;
  address: string;
  path: string;
}

export function getDerivationPath(index: number): string {
  return `${DERIVATION_PATH_PREFIX}/${index}`;
}

export function deriveWalletAtIndex(
  mnemonic: string,
  index: number,
): HDNodeWallet {
  return HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(mnemonic),
    getDerivationPath(index),
  );
}

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
