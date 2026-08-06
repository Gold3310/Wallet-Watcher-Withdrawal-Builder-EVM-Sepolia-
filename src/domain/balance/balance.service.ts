import { formatEther } from "ethers";
import { getProvider } from "../../infra/rpc/provider.js";
import {
  getAllWallets,
  getWalletByIndex,
  insertLedgerEntry,
  updateWalletBalance,
  upsertWallet,
  WalletRow,
} from "../../infra/db/database.js";
import { deriveConfiguredWallets } from "../wallet/wallet.service.js";

export interface WalletView {
  index: number;
  address: string;
  balanceWei: string;
  balanceEth: string;
}

export function initializeWallets(): WalletRow[] {
  const derived = deriveConfiguredWallets();
  return derived.map(({ index, address }) => upsertWallet(index, address));
}

export function getWalletViews(): WalletView[] {
  return getAllWallets().map(toWalletView);
}

export function getWalletViewByIndex(index: number): WalletView | undefined {
  const wallet = getWalletByIndex(index);
  return wallet ? toWalletView(wallet) : undefined;
}

export async function syncWalletBalance(wallet: WalletRow): Promise<boolean> {
  const provider = getProvider();
  const onChainBalance = await provider.getBalance(wallet.address);
  const onChainBalanceWei = onChainBalance.toString();
  const previousBalanceWei = BigInt(wallet.balance_wei);
  const nextBalanceWei = BigInt(onChainBalanceWei);

  if (nextBalanceWei === previousBalanceWei) {
    return false;
  }

  updateWalletBalance(wallet.id, onChainBalanceWei);

  if (nextBalanceWei > previousBalanceWei) {
    insertLedgerEntry(
      wallet.id,
      "inflow",
      (nextBalanceWei - previousBalanceWei).toString(),
    );
  }

  return true;
}

export async function syncAllWalletBalances(): Promise<number> {
  const wallets = getAllWallets();
  let changedCount = 0;

  for (const wallet of wallets) {
    const changed = await syncWalletBalance(wallet);
    if (changed) {
      changedCount += 1;
    }
  }

  return changedCount;
}

function toWalletView(wallet: WalletRow): WalletView {
  return {
    index: wallet.index,
    address: wallet.address,
    balanceWei: wallet.balance_wei,
    balanceEth: formatEther(wallet.balance_wei),
  };
}
