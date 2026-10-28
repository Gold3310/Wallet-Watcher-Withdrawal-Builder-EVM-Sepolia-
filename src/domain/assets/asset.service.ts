/**
 * Asset reporting: native balance plus any configured ERC-20 balances.
 *
 * Read-only `eth_call` against the contracts in `TRACKED_CONTRACT`. Nothing
 * here signs or sends.
 *
 * Metadata calls are treated as optional on purpose: plenty of real tokens have
 * a `symbol()` or `decimals()` that reverts or returns something odd, and a
 * broken label should not stop the balance from being reported.
 */
import { formatEther, formatUnits, Interface } from "ethers";
import { config } from "../../config/index.js";
import { getAllWallets, getWalletByIndex, WalletRow } from "../../infra/db/database.js";
import { getProvider } from "../../infra/rpc/provider.js";

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

export const erc20Interface = new Interface(ERC20_ABI as unknown as string[]);

export interface CallProvider {
  call(tx: { to: string; data: string }): Promise<string>;
  getBalance(address: string): Promise<bigint>;
}

export interface TokenAsset {
  address: string;
  symbol: string | null;
  decimals: number | null;
  /** Raw uint256 balance, in the token's smallest unit. */
  balanceRaw: string;
  /** Human-readable balance, or null when decimals could not be read. */
  balanceFormatted: string | null;
  error: string | null;
}

export interface WalletAssets {
  index: number;
  address: string;
  nativeWei: string;
  nativeEth: string;
  tokens: TokenAsset[];
}

export interface AssetTotals {
  nativeWei: string;
  nativeEth: string;
  tokens: {
    address: string;
    symbol: string | null;
    decimals: number | null;
    totalRaw: string;
    totalFormatted: string | null;
  }[];
}

async function callOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function readTokenAsset(
  provider: CallProvider,
  token: string,
  holder: string,
): Promise<TokenAsset> {
  const balance = await callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: erc20Interface.encodeFunctionData("balanceOf", [holder]),
    });
    return erc20Interface.decodeFunctionResult("balanceOf", result)[0] as bigint;
  });

  if (balance === null) {
    return {
      address: token,
      symbol: null,
      decimals: null,
      balanceRaw: "0",
      balanceFormatted: null,
      error: "balanceOf call failed — not a token, or the wrong chain",
    };
  }

  const decimals = await callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: erc20Interface.encodeFunctionData("decimals"),
    });
    return Number(erc20Interface.decodeFunctionResult("decimals", result)[0]);
  });

  const symbol = await callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: erc20Interface.encodeFunctionData("symbol"),
    });
    return erc20Interface.decodeFunctionResult("symbol", result)[0] as string;
  });

  return {
    address: token,
    symbol,
    decimals,
    balanceRaw: balance.toString(),
    balanceFormatted: decimals === null ? null : formatUnits(balance, decimals),
    error: null,
  };
}

export async function getWalletAssets(
  wallet: WalletRow,
  provider: CallProvider = getProvider() as unknown as CallProvider,
): Promise<WalletAssets> {
  const native = await provider.getBalance(wallet.address);
  const tokens = await Promise.all(
    config.trackedContracts.map((token) => readTokenAsset(provider, token, wallet.address)),
  );

  return {
    index: wallet.index,
    address: wallet.address,
    nativeWei: native.toString(),
    nativeEth: formatEther(native),
    tokens,
  };
}

export async function getWalletAssetsByIndex(
  index: number,
  provider?: CallProvider,
): Promise<WalletAssets> {
  const wallet = getWalletByIndex(index);
  if (!wallet) {
    throw new Error(`Wallet index ${index} does not exist`);
  }
  return getWalletAssets(wallet, provider);
}

export async function getAllWalletAssets(
  provider?: CallProvider,
): Promise<WalletAssets[]> {
  const wallets = getAllWallets();
  return Promise.all(
    wallets.map((wallet) =>
      provider ? getWalletAssets(wallet, provider) : getWalletAssets(wallet),
    ),
  );
}

/** Sums each asset across every tracked wallet. */
export function totalsOf(assets: WalletAssets[]): AssetTotals {
  let native = 0n;
  const tokens = new Map<
    string,
    { symbol: string | null; decimals: number | null; total: bigint }
  >();

  for (const wallet of assets) {
    native += BigInt(wallet.nativeWei);

    for (const token of wallet.tokens) {
      const key = token.address.toLowerCase();
      const entry = tokens.get(key) ?? {
        symbol: token.symbol,
        decimals: token.decimals,
        total: 0n,
      };

      entry.total += BigInt(token.balanceRaw);
      if (entry.symbol === null) {
        entry.symbol = token.symbol;
      }
      if (entry.decimals === null) {
        entry.decimals = token.decimals;
      }
      tokens.set(key, entry);
    }
  }

  return {
    nativeWei: native.toString(),
    nativeEth: formatEther(native),
    tokens: [...tokens.entries()].map(([address, entry]) => ({
      address,
      symbol: entry.symbol,
      decimals: entry.decimals,
      totalRaw: entry.total.toString(),
      totalFormatted: entry.decimals === null ? null : formatUnits(entry.total, entry.decimals),
    })),
  };
}
