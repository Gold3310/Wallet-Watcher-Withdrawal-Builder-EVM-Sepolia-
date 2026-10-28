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
  CONTRACT_CREATOR,
  hubPoolInterface,
  trackedContractInterface,
  TRANSFER_RESTRICTION,
  UNWRAP_FUNCTION,
} from "./abi.js";
import {
  readHolderReport,
  HolderOfInterest,
  HolderReport,
} from "./holders.js";

export {
  CONTRACT_CREATOR,
  HUB_POOL_ABI,
  HUB_POOL_IMMUTABLE,
  hubPoolInterface,
  TRACKED_CONTRACT_ABI,
  trackedContractInterface,
  TRANSFER_RESTRICTION,
  UNWRAP_FUNCTION,
} from "./abi.js";

export { readHolderReport } from "./holders.js";
export type {
  HolderBalance,
  HolderOfInterest,
  HolderReport,
} from "./holders.js";

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
  /**
   * On-chain owner. This is NOT the same thing as this service's
   * `OWNER_ADDRESS`, and holding it grants no right to move value.
   */
  owner: string | null;
  /**
   * Whether the on-chain owner is the address configured as this service's
   * owner. Almost always false, and worth reporting rather than assuming.
   * Null when either side is unset or unreadable.
   */
  ownerIsServiceOwner: boolean | null;
  /** The hubPool the contract was deployed against, pinned at construction. */
  hubPool: string | null;
  /**
   * The one destination that is gated, when the contract has such a rule.
   * Transfers to any other address are unrestricted.
   */
  restrictedDestination: string | null;
  /** Plain statement of the gate, from the verified source. */
  restriction: string;
  /**
   * ETH held by the contract. For a WETH-style token this IS the redemption
   * backing: `totalSupply()` returns `address(this).balance`, and `withdraw()`
   * pays out of that ETH.
   */
  ethReserveRaw: string | null;
  ethReserveFormatted: string | null;
  /**
   * Whether the contract holds enough ETH to redeem the entire supply.
   * Null when either side could not be read.
   */
  fullyBacked: boolean | null;
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
  const [name, symbol, decimals, totalSupply, owner, hubPool, ethReserve] =
    await Promise.all([
      readString(provider, token, "name"),
      readString(provider, token, "symbol"),
      readUint(provider, token, "decimals"),
      readUint(provider, token, "totalSupply"),
      readAddress(provider, token, "owner"),
      readAddress(provider, token, "hubPool"),
      callOrNull(() => provider.getBalance(token)),
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
    ownerIsServiceOwner:
      owner === null || !config.ownerAddress
        ? null
        : owner.toLowerCase() === config.ownerAddress.toLowerCase(),
    hubPool,
    restrictedDestination: hubPool,
    restriction: TRANSFER_RESTRICTION,
    ethReserveRaw: ethReserve === null ? null : ethReserve.toString(),
    ethReserveFormatted: ethReserve === null ? null : formatEther(ethReserve),
    fullyBacked:
      ethReserve === null || totalSupply === null ? null : ethReserve >= totalSupply,
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

/**
 * Every address worth asking about, in the order that makes the answer
 * legible: the contract first, since its own balance is the claim being
 * tested, then the roles people assume matter, then the wallets this service
 * can actually sign for.
 */
export function holdersOfInterest(): HolderOfInterest[][] {
  return config.trackedContracts.map((contract) => {
    const holders: HolderOfInterest[] = [
      {
        label: "the contract itself (the ledger, not a holder)",
        address: contract,
        signableByService: false,
      },
    ];

    if (config.ownerAddress) {
      holders.push({
        label: "service owner address (an API credential, not a token holder)",
        address: config.ownerAddress,
        signableByService: false,
      });
    }

    holders.push({
      label: "contract deployer",
      address: CONTRACT_CREATOR,
      signableByService: false,
    });

    for (const wallet of getAllWallets()) {
      holders.push({
        label: `derived wallet ${wallet.index}`,
        address: wallet.address,
        signableByService: true,
      });
    }

    return holders;
  });
}

/**
 * Who holds the tracked token, and therefore who can redeem the contract's ETH.
 *
 * The contract's own balance is included deliberately: the belief that a
 * contract holds the balances in its own `balanceOf` mapping is the one that
 * makes this look solvable when it is not, and it is settled by reading
 * `balanceOf(<the contract>)` rather than by argument.
 */
export async function getHolderReports(
  provider?: CallProvider,
): Promise<HolderReport[]> {
  const resolved = provider ?? (getProvider() as unknown as CallProvider);
  const holderSets = holdersOfInterest();

  return Promise.all(
    config.trackedContracts.map((contract, i) =>
      readHolderReport(resolved, contract, holderSets[i]),
    ),
  );
}
