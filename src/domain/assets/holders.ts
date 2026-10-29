/**
 * Who actually holds the tracked token.
 *
 * This module exists because of one specific misconception that decides
 * everything downstream: that a contract "holds" the balances recorded in its
 * own `balanceOf` mapping.
 *
 * It does not. That mapping is a ledger stored *in* the contract's storage. The
 * keys are addresses; the values are amounts that belong to those addresses.
 * The contract is the ledger-keeper, not the holder of the entries. For the
 * contract to hold its own token, `balanceOf(<the contract itself>)` would have
 * to be greater than zero — which is a readable fact, so this report reads it
 * and prints it instead of arguing about it.
 *
 * Why that question is the whole ballgame for a WETH-style token:
 *
 *   - `withdraw(uint256)` is ungated. Anyone holding a balance can call it.
 *   - It burns the balance and pays out ETH 1:1 from the contract's reserve.
 *
 * So "who can take the ETH?" and "who holds the token?" are the same question
 * with the same answer. If no address you control holds the token, the contract's
 * ETH reserve is unreachable — not because of a missing feature, but because
 * there is no code path from here to there. Ownership does not help (Ownable has
 * no withdraw). Being the deployer does not help. Deriving a wallet does not
 * help. Only holding the balance does.
 *
 * Everything here is read-only `eth_call`. Nothing signs, nothing sends.
 */
import { formatEther, formatUnits } from "ethers";
import { trackedContractInterface } from "./abi.js";

export interface HolderOfInterest {
  /** Who this address is, in the operator's terms. */
  label: string;
  address: string;
  /**
   * Whether this service can sign for it. A balance held at an address it
   * cannot sign for is a fact to report, not a balance it can move.
   */
  signableByService: boolean;
}

export interface HolderBalance {
  label: string;
  address: string;
  balanceRaw: string | null;
  balanceFormatted: string | null;
  /** Share of totalSupply, as a percentage string. Null when unreadable. */
  shareOfSupply: string | null;
  /**
   * ETH this holder could take right now via the ungated `withdraw()`.
   * Capped at the contract's ETH reserve: a balance backed by no ETH is a
   * claim on nothing.
   */
  redeemableEth: string | null;
  /**
   * Whether `withdraw()` for the full balance would succeed at this moment.
   * Needs a non-zero balance and a reserve at least that large.
   */
  canWithdrawNow: boolean | null;
  /**
   * ETH the address holds for gas. A redeemable balance at an address with no
   * ETH is stranded by gas rather than by entitlement — that is the one case
   * where paying someone else's gas changes the outcome.
   */
  nativeWei: string | null;
  nativeEth: string | null;
  /**
   * What is actually stopping this address from redeeming:
   *
   * - `nothing-to-redeem` — no balance. Sponsoring gas changes nothing; there
   *   is no claim to exercise.
   * - `gas-blocked` — a balance worth redeeming and no ETH to pay for the
   *   transaction. This is the only case gasless fixes.
   * - `ready` — a balance and the gas to move it.
   */
  accessStatus: "nothing-to-redeem" | "gas-blocked" | "ready" | "unknown";
  signableByService: boolean;
  error: string | null;
}

export interface HolderReport {
  contract: string;
  symbol: string | null;
  decimals: number | null;
  totalSupplyRaw: string | null;
  totalSupplyFormatted: string | null;
  /** ETH held by the contract — the redemption backing for the whole supply. */
  ethReserveRaw: string | null;
  ethReserveFormatted: string | null;
  /**
   * The contract's balance in itself — the number that settles whether "the
   * contract holds the tokens" is true. It is almost always zero.
   */
  contractOwnBalanceRaw: string | null;
  holders: HolderBalance[];
  /** Sum across the addresses in this report. */
  reportedTotalRaw: string | null;
  reportedTotalFormatted: string | null;
  /**
   * Supply not held by any address listed here. When this is the entire
   * supply, none of these addresses holds the token, and the reserve is not
   * redeemable from any of them.
   */
  unaccountedRaw: string | null;
  unaccountedFormatted: string | null;
  /**
   * Supply held by addresses this service cannot sign for, excluding the
   * contract's own entry. When this is the whole supply, the entire float sits
   * outside this service's control and the reserve behind it is unreachable
   * from here.
   */
  thirdPartyTotalRaw: string | null;
  thirdPartyTotalFormatted: string | null;
  /** Plain reading of the numbers above, so nobody has to infer it. */
  verdict: string;
}

async function readOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function readBalance(
  provider: { call(tx: { to: string; data: string }): Promise<string> },
  token: string,
  holder: string,
): Promise<bigint | null> {
  return readOrNull(async () => {
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
  provider: { call(tx: { to: string; data: string }): Promise<string> },
  token: string,
  fn: "decimals" | "totalSupply",
): Promise<bigint | null> {
  return readOrNull(async () => {
    const result = await provider.call({
      to: token,
      data: trackedContractInterface.encodeFunctionData(fn),
    });
    return trackedContractInterface.decodeFunctionResult(fn, result)[0] as bigint;
  });
}

/** Converts a raw token amount into the ETH it redeems for, at 1:1. */
function toRedeemableWei(balance: bigint, decimals: number): bigint {
  return decimals >= 18
    ? balance / 10n ** BigInt(decimals - 18)
    : balance * 10n ** BigInt(18 - decimals);
}

function percentage(part: bigint, whole: bigint): string | null {
  if (whole === 0n) {
    return null;
  }
  // Hundredths of a basis point, rounded to four decimal places so the figure
  // matches what a block explorer shows rather than landing one digit short.
  const scaled = (part * 1_000_000n + whole / 2n) / whole;
  const wholePart = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, "0");
  return `${wholePart}.${fraction}`;
}

/**
 * Why an address cannot redeem, in the order that matters.
 *
 * Sponsoring gas is often pitched as removing the last barrier. It removes
 * exactly one barrier: having a claim and no ETH to exercise it. Where there is
 * no claim, it changes nothing at all — which is the distinction worth stating
 * explicitly rather than letting "gasless" imply access.
 */
export function classifyAccess(
  balance: bigint,
  nativeWei: bigint | null,
  redeemableWei: bigint | null,
): "nothing-to-redeem" | "gas-blocked" | "ready" | "unknown" {
  if (balance <= 0n || redeemableWei === null || redeemableWei <= 0n) {
    return "nothing-to-redeem";
  }

  if (nativeWei === null) {
    return "unknown";
  }

  return nativeWei === 0n ? "gas-blocked" : "ready";
}

export interface ReadHolderReportDeps {
  contract: string;
  holders: HolderOfInterest[];
  decimals: number | null;
  symbol: string | null;
  totalSupply: bigint | null;
  ethReserve: bigint | null;
  balances: (bigint | null)[];
  /** ETH each holder has for gas. Optional so the pure path stays readable. */
  nativeBalances?: (bigint | null)[];
}

/**
 * Pure assembly, separated from the RPC reads so the verdict logic — the part
 * worth testing — can be exercised without a provider.
 */
export function buildHolderReport(deps: ReadHolderReportDeps): HolderReport {
  const { contract, holders, decimals, symbol, totalSupply, ethReserve } = deps;

  const effectiveDecimals = decimals ?? 18;

  const rows: HolderBalance[] = holders.map((holder, i) => {
    const raw = deps.balances[i];
    const native = deps.nativeBalances?.[i] ?? null;

    if (raw === null) {
      return {
        label: holder.label,
        address: holder.address,
        balanceRaw: null,
        balanceFormatted: null,
        shareOfSupply: null,
        redeemableEth: null,
        canWithdrawNow: null,
        nativeWei: null,
        nativeEth: null,
        accessStatus: "unknown",
        signableByService: holder.signableByService,
        error: "balanceOf read failed",
      };
    }

    const balance = raw;
    const redeemableWei =
      decimals === null ? null : toRedeemableWei(balance, decimals);
    const capped =
      redeemableWei === null || ethReserve === null
        ? null
        : redeemableWei > ethReserve
          ? ethReserve
          : redeemableWei;

    return {
      label: holder.label,
      address: holder.address,
      balanceRaw: balance.toString(),
      balanceFormatted: formatUnits(balance, effectiveDecimals),
      shareOfSupply:
        totalSupply === null ? null : percentage(balance, totalSupply),
      redeemableEth: capped === null ? null : formatEther(capped),
      canWithdrawNow:
        ethReserve === null || redeemableWei === null
          ? null
          : balance > 0n && redeemableWei <= ethReserve,
      nativeWei: native === null ? null : native.toString(),
      nativeEth: native === null ? null : formatEther(native),
      accessStatus: classifyAccess(
        balance,
        native,
        capped ?? redeemableWei,
      ),
      signableByService: holder.signableByService,
      error: null,
    };
  });

  const known = rows.reduce(
    (sum, row) => (row.balanceRaw === null ? sum : sum + BigInt(row.balanceRaw)),
    0n,
  );

  const contractRow = rows.find(
    (row) => row.address.toLowerCase() === contract.toLowerCase(),
  );

  const signable = rows.filter((row) => row.signableByService);
  const gasBlocked = signable.filter(
    (row) => row.accessStatus === "gas-blocked",
  );
  const signableTotal = signable.reduce(
    (sum, row) => (row.balanceRaw === null ? sum : sum + BigInt(row.balanceRaw)),
    0n,
  );

  const ownBalance =
    contractRow?.balanceRaw === null || contractRow?.balanceRaw === undefined
      ? null
      : BigInt(contractRow.balanceRaw);

  const thirdParty =
    totalSupply === null || ownBalance === null
      ? null
      : totalSupply - signableTotal - ownBalance < 0n
        ? 0n
        : totalSupply - signableTotal - ownBalance;

  return {
    contract,
    symbol,
    decimals,
    totalSupplyRaw: totalSupply === null ? null : totalSupply.toString(),
    totalSupplyFormatted:
      totalSupply === null ? null : formatUnits(totalSupply, effectiveDecimals),
    ethReserveRaw: ethReserve === null ? null : ethReserve.toString(),
    ethReserveFormatted: ethReserve === null ? null : formatEther(ethReserve),
    contractOwnBalanceRaw: contractRow ? contractRow.balanceRaw : null,
    holders: rows,
    reportedTotalRaw: known.toString(),
    reportedTotalFormatted: formatUnits(known, effectiveDecimals),
    unaccountedRaw:
      totalSupply === null ? null : (totalSupply - known).toString(),
    unaccountedFormatted:
      totalSupply === null
        ? null
        : formatUnits(totalSupply - known, effectiveDecimals),
    thirdPartyTotalRaw: thirdParty === null ? null : thirdParty.toString(),
    thirdPartyTotalFormatted:
      thirdParty === null ? null : formatUnits(thirdParty, effectiveDecimals),
    verdict: verdictFor({
      symbol,
      decimals: effectiveDecimals,
      totalSupply,
      ethReserve,
      contractOwnBalance: contractRow?.balanceRaw ?? null,
      signableTotal,
      gasBlockedCount: gasBlocked.length,
      thirdPartyTotal: thirdParty,
    }),
  };
}

interface VerdictInput {
  symbol: string | null;
  decimals: number;
  totalSupply: bigint | null;
  ethReserve: bigint | null;
  contractOwnBalance: string | null;
  signableTotal: bigint;
  gasBlockedCount: number;
  thirdPartyTotal: bigint | null;
}

function verdictFor(input: VerdictInput): string {
  const token = input.symbol ?? "the token";

  if (input.totalSupply === null) {
    return `Could not read totalSupply for ${token}, so nothing is concluded ` +
      `here. Check the RPC endpoint and that the contract is on this chain.`;
  }

  const parts: string[] = [];

  // The claim this report exists to settle, answered with the number itself.
  if (input.contractOwnBalance !== null) {
    const own = BigInt(input.contractOwnBalance);
    parts.push(
      own === 0n
        ? `The contract holds none of ${token} in itself. Its balanceOf entry ` +
            `is zero: the contract is the ledger that records who holds the ` +
            `token, not a holder of it.`
        : `The contract holds ${formatUnits(own, input.decimals)} ${token} in ` +
            `itself, which is unusual for a WETH-style token. That balance is ` +
            `its own entry in the ledger and is not spendable by the owner.`,
    );
  }

  parts.push(
    `Total supply is ${formatUnits(input.totalSupply, input.decimals)} ` +
      `${token}, backed by ` +
      `${input.ethReserve === null ? "an unreadable" : formatEther(input.ethReserve)} ` +
      `ETH reserve.`,
  );

  if (
    input.signableTotal === 0n &&
    input.thirdPartyTotal !== null &&
    input.thirdPartyTotal > 0n
  ) {
    const share =
      input.totalSupply === 0n
        ? null
        : percentage(input.thirdPartyTotal, input.totalSupply);

    parts.push(
      `Every ${token} in existence — ` +
        `${formatUnits(input.thirdPartyTotal, input.decimals)}` +
        `${share === null ? "" : `, ${share}% of supply`} — sits at addresses ` +
        `this service cannot sign for. Naming them does not bring them closer: ` +
        `withdraw() must be called by a holder, and none of these is one.`,
    );
  }

  if (input.gasBlockedCount > 0) {
    parts.push(
      `${input.gasBlockedCount} wallet(s) this service can sign for hold a ` +
        `redeemable balance but no ETH to pay for the transaction. Sponsoring ` +
        `gas would unblock exactly those — it is the one situation where ` +
        `paying someone else's gas changes the outcome, and it changes nothing ` +
        `for any address that holds no balance at all.`,
    );
  }

  if (input.signableTotal > 0n) {
    parts.push(
      `Wallets this service can sign for hold ` +
        `${formatUnits(input.signableTotal, input.decimals)} ${token}, which ` +
        `the ungated withdraw() can turn into ETH right now.`,
    );
  } else {
    parts.push(
      `No address this service can sign for holds any ${token}. With ` +
        `withdraw() being the only way to release the reserve, and withdraw() ` +
        `requiring a balance to burn, the ETH is not reachable from here. Not ` +
        `by the owner, not by the deployer, and not by deriving another wallet ` +
        `— only by holding the token.`,
    );
  }

  return parts.join(" ");
}

/** Reads everything from the chain and assembles the report. */
export async function readHolderReport(
  provider: {
    call(tx: { to: string; data: string }): Promise<string>;
    getBalance(address: string): Promise<bigint>;
  },
  contract: string,
  holders: HolderOfInterest[],
): Promise<HolderReport> {
  const [decimals, totalSupply, symbol, ethReserve, ...rest] =
    await Promise.all([
      readUint(provider, contract, "decimals"),
      readUint(provider, contract, "totalSupply"),
      readOrNull(async () => {
        const result = await provider.call({
          to: contract,
          data: trackedContractInterface.encodeFunctionData("symbol"),
        });
        return trackedContractInterface.decodeFunctionResult("symbol", result)[0] as string;
      }),
      readOrNull(() => provider.getBalance(contract)),
      ...holders.map((holder) => readBalance(provider, contract, holder.address)),
      ...holders.map((holder) => readOrNull(() => provider.getBalance(holder.address))),
    ]);

  // `rest` is balances first, then native balances, in the same order.
  const balances = rest.slice(0, holders.length) as (bigint | null)[];
  const nativeBalances = rest.slice(holders.length) as (bigint | null)[];

  return buildHolderReport({
    contract,
    holders,
    decimals: decimals === null ? null : Number(decimals),
    symbol,
    totalSupply,
    ethReserve,
    balances,
    nativeBalances,
  });
}
