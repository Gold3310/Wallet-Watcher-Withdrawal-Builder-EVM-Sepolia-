/**
 * Asset reporting: native balance plus any configured ERC-20 balances.
 *
 * Read-only `eth_call` against the contracts in `TRACKED_CONTRACT`. Nothing
 * here signs or sends.
 *
 * Calls are encoded with the tracked contract's real ABI rather than a minimal
 * ERC-20 fragment, because that contract is not a plain ERC-20 — its
 * `transfer`/`transferFrom` are gated, so a balance is not the same thing as a
 * spendable balance. Reporting answers `canTransfer` alongside the amount.
 *
 * Metadata calls are treated as optional on purpose: plenty of real tokens have
 * a `symbol()` or `decimals()` that reverts or returns something odd, and a
 * broken label should not stop the balance from being reported.
 */
import { formatEther, formatUnits } from "ethers";
import { config } from "../../config/index.js";
import { getAllWallets, getWalletByIndex, WalletRow } from "../../infra/db/database.js";
import { getProvider } from "../../infra/rpc/provider.js";
import {
  hubPoolInterface,
  trackedContractInterface,
  TRANSFER_RESTRICTION,
  UNWRAP_FUNCTION,
} from "./abi.js";

export {
  HUB_POOL_ABI,
  HUB_POOL_IMMUTABLE,
  hubPoolInterface,
  TRACKED_CONTRACT_ABI,
  trackedContractInterface,
  TRANSFER_RESTRICTION,
  UNWRAP_FUNCTION,
} from "./abi.js";

/** Kept for callers that only want the ERC-20 subset. */
export const erc20Interface = trackedContractInterface;

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
  /**
   * Whether this holder may transfer to the contract's restricted destination,
   * which for BondToken is the hubPool — the only transfer that is gated at
   * all. Transfers to every other address are unrestricted.
   *
   * `true` means nothing would block the transfer. `null` means the contract
   * publishes no way to tell, or a read failed, so the answer is unknown
   * rather than assumed to be yes.
   */
  canTransferToRestrictedDestination: boolean | null;
  error: string | null;
}

/** Everything about a tracked contract that is not specific to a holder. */
export interface ContractInfo {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupplyRaw: string | null;
  totalSupplyFormatted: string | null;
  /** On-chain owner. This is NOT the same thing as this service's owner. */
  owner: string | null;
  /** The hubPool the contract was deployed against, pinned at construction. */
  hubPool: string | null;
  /**
   * The one destination that is gated, when the contract has such a rule.
   * Transfers to any other address are unrestricted.
   */
  restrictedDestination: string | null;
  /** Plain statement of the gate, from the verified source. */
  restriction: string;
  /** Function to call to turn a balance back into ETH. */
  unwrapFunction: string | null;
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

/** Raw token balance, or null when the call fails. */
export async function readTokenBalanceRaw(
  provider: CallProvider,
  token: string,
  holder: string,
): Promise<bigint | null> {
  return callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: trackedContractInterface.encodeFunctionData("balanceOf", [holder]),
    });
    return trackedContractInterface.decodeFunctionResult(
      "balanceOf",
      result,
    )[0] as bigint;
  });
}

async function readUint(
  provider: CallProvider,
  token: string,
  fn: "decimals" | "totalSupply",
): Promise<bigint | null> {
  return callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: trackedContractInterface.encodeFunctionData(fn),
    });
    return trackedContractInterface.decodeFunctionResult(fn, result)[0] as bigint;
  });
}

async function readString(
  provider: CallProvider,
  token: string,
  fn: "symbol" | "name",
): Promise<string | null> {
  return callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: trackedContractInterface.encodeFunctionData(fn),
    });
    return trackedContractInterface.decodeFunctionResult(fn, result)[0] as string;
  });
}

async function readAddress(
  provider: CallProvider,
  token: string,
  fn: "owner" | "hubPool",
): Promise<string | null> {
  return callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: trackedContractInterface.encodeFunctionData(fn),
    });
    return trackedContractInterface.decodeFunctionResult(fn, result)[0] as string;
  });
}

/** The address currently recorded as the pending root-bundle proposer. */
async function readRootBundleProposer(
  provider: CallProvider,
  hubPool: string,
): Promise<string | null> {
  return callOrNull(async () => {
    const result = await provider.call({
      to: hubPool,
      data: hubPoolInterface.encodeFunctionData("rootBundleProposal"),
    });
    const root = hubPoolInterface.decodeFunctionResult(
      "rootBundleProposal",
      result,
    )[0];
    return (root as { proposer: string }).proposer;
  });
}

/**
 * Evaluates the contract's one gate, straight from the verified source:
 *
 *     if (dst == address(hubPool)) {
 *         require(proposers[src] || hubPool.rootBundleProposal().proposer != src,
 *                 "Transfer not permitted");
 *     }
 *
 * With no restricted destination there is nothing to gate, so nothing blocks a
 * transfer.
 */
async function readCanTransferToRestrictedDestination(
  provider: CallProvider,
  token: string,
  holder: string,
  restrictedDestination: string | null,
): Promise<boolean | null> {
  if (restrictedDestination === null) {
    return true;
  }

  const proposer = await callOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: trackedContractInterface.encodeFunctionData("proposers", [holder]),
    });
    return trackedContractInterface.decodeFunctionResult(
      "proposers",
      result,
    )[0] as boolean;
  });

  if (proposer === null) {
    return null;
  }

  if (proposer) {
    return true;
  }

  const current = await readRootBundleProposer(provider, restrictedDestination);

  if (current === null) {
    return null;
  }

  // Blocked only while you are the pending proposer and not approved.
  return current.toLowerCase() !== holder.toLowerCase();
}

export async function readTokenAsset(
  provider: CallProvider,
  token: string,
  holder: string,
): Promise<TokenAsset> {
  const balance = await readTokenBalanceRaw(provider, token, holder);

  if (balance === null) {
    return {
      address: token,
      symbol: null,
      decimals: null,
      balanceRaw: "0",
      balanceFormatted: null,
      canTransferToRestrictedDestination: null,
      error: "balanceOf call failed — not a token, or the wrong chain",
    };
  }

  const hubPool = await readAddress(provider, token, "hubPool");
  const [decimals, symbol, canTransferToRestrictedDestination] =
    await Promise.all([
      readUint(provider, token, "decimals"),
      readString(provider, token, "symbol"),
      readCanTransferToRestrictedDestination(provider, token, holder, hubPool),
    ]);

  return {
    address: token,
    symbol,
    decimals: decimals === null ? null : Number(decimals),
    balanceRaw: balance.toString(),
    balanceFormatted: decimals === null ? null : formatUnits(balance, Number(decimals)),
    canTransferToRestrictedDestination,
    error: null,
  };
}

/** Contract-level facts: metadata, supply, owner and the transfer gate. */
export async function readContractInfo(
  provider: CallProvider,
  token: string,
): Promise<ContractInfo> {
  const [name, symbol, decimals, totalSupply, owner, hubPool] = await Promise.all([
    readString(provider, token, "name"),
    readString(provider, token, "symbol"),
    readUint(provider, token, "decimals"),
    readUint(provider, token, "totalSupply"),
    readAddress(provider, token, "owner"),
    readAddress(provider, token, "hubPool"),
  ]);

  return {
    address: token,
    name,
    symbol,
    decimals: decimals === null ? null : Number(decimals),
    totalSupplyRaw: totalSupply === null ? null : totalSupply.toString(),
    totalSupplyFormatted:
      totalSupply === null || decimals === null
        ? null
        : formatUnits(totalSupply, Number(decimals)),
    owner,
    hubPool,
    restrictedDestination: hubPool,
    restriction: TRANSFER_RESTRICTION,
    unwrapFunction: UNWRAP_FUNCTION,
    error: null,
  };
}

export async function getTrackedContractInfo(
  provider?: CallProvider,
): Promise<ContractInfo[]> {
  const resolved = provider ?? (getProvider() as unknown as CallProvider);
  return Promise.all(
    config.trackedContracts.map((token) => readContractInfo(resolved, token)),
  );
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
