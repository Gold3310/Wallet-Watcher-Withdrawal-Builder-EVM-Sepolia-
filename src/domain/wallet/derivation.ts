/**
 * BIP-44 derivation, with no dependency on config or a network.
 *
 * Kept separate from `wallet.service.ts` so that key-handling tools can derive
 * a wallet without booting a provider or loading a whole config — deriving a
 * key needs a mnemonic and nothing else.
 */
import { HDNodeWallet, Mnemonic } from "ethers";

/** BIP-44 path for Ethereum, external chain: m/44'/60'/0'/0/<index>. */
export const DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0";

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
