/**
 * Sweeping ETH and ERC-20 balances from the derived wallets to one destination.
 *
 * A sweep plans every wallet first and sends nothing unless `broadcast: true`.
 * Policy limits (destination allowlist, mainnet cap, configured cap, velocity)
 * are enforced across the whole batch before a single transaction is sent, so
 * a guardrail violation on wallet 4 cannot leave wallets 0..3 half-swept.
 *
 * Within each wallet, transactions run in the only order that keeps funds
 * reachable:
 *
 *   1. Unwrap wrapped ETH (`withdraw(balance)`), if requested.
 *   2. Transfer remaining ERC-20 tokens (`transfer(to, balance)`).
 *   3. Sweep remaining native ETH (`balance - 21_000 * maxFeePerGas`).
 *
 * Planning uses `peekNonce` so previewing never consumes nonces. Broadcasting
 * uses `allocateNonce` at send time, waits for prior token steps to confirm
 * when the provider supports it so the final ETH sweep picks up the exact live
 * balance, and records native ETH outflows in the ledger.
 */
import {
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  Transaction,
  ZeroAddress,
} from "ethers";
import { config } from "../../config/index.js";
import { getWalletByIndex, WalletRow } from "../../infra/db/database.js";
import { getProvider } from "../../infra/rpc/provider.js";
import {
  describeGasReadiness,
  getRelayer,
  type Relayer,
} from "../../infra/rpc/relayer.js";
import { BadRequestError } from "../../util/errors.js";
import {
  CallProvider,
  readCanTransferToRestrictedDestination,
  readContractInfo,
  readTokenBalanceRaw,
  trackedContractInterface,
  UNWRAP_FUNCTION,
} from "../assets/asset.service.js";
import { syncWalletBalance } from "../balance/balance.service.js";
import { recordOutflow } from "../ledger/ledger.service.js";
import { allocateNonce, peekNonce, releaseNonce } from "../wallet/nonce.manager.js";
import { getSignerForIndex } from "../wallet/wallet.service.js";
import {
  assertDestinationAllowed,
  assertWithinConfiguredValueLimit,
  assertWithinNetworkValueLimit,
  assertWithinVelocityLimit,
  normalizeDestinationAddress,
} from "../withdrawal/withdrawal.service.js";

const SIMPLE_TRANSFER_GAS_LIMIT = 21_000n;
const CONFIRM_TIMEOUT_MS = 120_000;

export type SweepStepKind = "unwrap" | "erc20" | "eth";

export type SweepStepStatus =
  | "ready"
  | "broadcast"
  | "skipped"
  | "blocked"
  | "failed";

export interface SweepRequest {
  toAddress: string;
  /** Wallet indices to inspect. Defaults to every configured wallet (0..N-1). */
  walletIndices?: number[];
  /**
   * ERC-20 contracts to sweep. Defaults to `config.trackedContracts`; pass an
   * empty array for native ETH only.
   */
  tokens?: string[];
  /**
   * Unwrap wrapped ETH (`withdraw(balance)`) into native ETH before sweeping
   * ETH. Applies to `unwrapContracts` when given, otherwise to all swept tokens.
   */
  unwrap?: boolean;
  /** Specific contracts to unwrap before sweeping ETH (implies unwrap). */
  unwrapContracts?: string[];
  /** Sweep remaining native ETH after token actions (default: true). */
  includeNative?: boolean;
  /** Plan only by default; send transactions only when true. */
  broadcast: boolean;
  actor?: string | null;
}

export interface SweepStepResult {
  kind: SweepStepKind;
  status: SweepStepStatus;
  /** Token contract address for token steps; null for native ETH. */
  contract: string | null;
  symbol: string | null;
  decimals: number | null;
  amountRaw: string;
  amountFormatted: string | null;
  /** True in plan mode when ETH includes proceeds or gas deltas from earlier steps. */
  estimatedAfterPriorSteps?: boolean;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  estimatedGasWei?: string;
  shortfallWei?: string;
  nonce?: number;
  txHash?: string | null;
  serialized?: string;
  reason?: string;
}

export type WalletSweepStatus =
  | "ready"
  | "broadcast"
  | "partial"
  | "skipped"
  | "blocked"
  | "failed";

export interface WalletSweepResult {
  index: number;
  address: string;
  status: WalletSweepStatus;
  nativeWeiBefore: string;
  nativeEthBefore: string;
  steps: SweepStepResult[];
  reason?: string;
}

export interface SweepTokenTotal {
  contract: string;
  symbol: string | null;
  decimals: number | null;
  unwrapRaw: string;
  unwrapFormatted: string | null;
  transferRaw: string;
  transferFormatted: string | null;
}

export interface SweepReport {
  network: string;
  chainId: number;
  toAddress: string;
  broadcast: boolean;
  relayer: string;
  requestedBy: string | null;
  summary: {
    walletsScanned: number;
    walletsWithActions: number;
    stepsReady: number;
    stepsBroadcast: number;
    stepsSkipped: number;
    stepsBlocked: number;
    stepsFailed: number;
    totalEthWei: string;
    totalEthFormatted: string;
    tokenTotals: SweepTokenTotal[];
  };
  wallets: WalletSweepResult[];
  notes: string[];
}

interface UnsignedStepTx {
  to: string;
  data?: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface InternalStep {
  result: SweepStepResult;
  tx?: UnsignedStepTx;
  /** True when the step is a native ETH sweep gated by ETH value caps. */
  checkVelocity?: boolean;
}

interface InternalWalletPlan {
  wallet: WalletRow;
  nativeWeiBefore: bigint;
  steps: InternalStep[];
  reason?: string;
}

interface ContractMeta {
  address: string;
  symbol: string | null;
  decimals: number | null;
  hubPool: string | null;
  remainingEthReserve: bigint | null;
}

function normalizeContractList(
  addresses: readonly string[] | undefined,
  field: string,
): string[] {
  if (!addresses) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of addresses) {
    if (typeof raw !== "string" || !isAddress(raw)) {
      throw new BadRequestError(`${field} contains an invalid address: ${String(raw)}`);
    }
    const checksummed = getAddress(raw);
    if (checksummed === ZeroAddress) {
      throw new BadRequestError(`${field} cannot include the zero address`);
    }
    if (!seen.has(checksummed)) {
      seen.add(checksummed);
      normalized.push(checksummed);
    }
  }

  return normalized;
}

function resolveWalletIndices(indices: readonly number[] | undefined): number[] {
  if (indices === undefined) {
    return Array.from({ length: config.walletCount }, (_, index) => index);
  }

  if (!Array.isArray(indices) || indices.length === 0) {
    throw new BadRequestError("walletIndices must be a non-empty array when provided");
  }

  const seen = new Set<number>();
  const resolved: number[] = [];

  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= config.walletCount) {
      throw new BadRequestError(
        `walletIndices entries must be integers between 0 and ${config.walletCount - 1}`,
      );
    }
    if (!seen.has(index)) {
      seen.add(index);
      resolved.push(index);
    }
  }

  return resolved;
}

function formatTokenAmount(raw: bigint, decimals: number | null): string | null {
  return decimals === null ? null : formatUnits(raw, decimals);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function signStepTx(
  walletIndex: number,
  tx: UnsignedStepTx,
  nonce: number,
): Promise<{ hash: string; serialized: string }> {
  const signer = getSignerForIndex(walletIndex);
  const serialized = await signer.signTransaction({
    type: 2,
    to: tx.to,
    data: tx.data ?? "0x",
    value: tx.value,
    nonce,
    chainId: config.chainId,
    gasLimit: tx.gasLimit,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  });
  const parsed = Transaction.from(serialized);
  return {
    hash: parsed.hash!,
    serialized,
  };
}

function deriveWalletStatus(
  steps: readonly SweepStepResult[],
  broadcastMode: boolean,
): WalletSweepStatus {
  const counts = {
    ready: 0,
    broadcast: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
  };

  for (const step of steps) {
    counts[step.status] += 1;
  }

  if (broadcastMode) {
    if (counts.broadcast > 0 && counts.failed === 0 && counts.blocked === 0) {
      return "broadcast";
    }
    if (counts.broadcast > 0) {
      return "partial";
    }
    if (counts.failed > 0) {
      return "failed";
    }
    if (counts.blocked > 0) {
      return "blocked";
    }
    return "skipped";
  }

  if (counts.ready > 0 && counts.blocked === 0) {
    return "ready";
  }
  if (counts.ready > 0) {
    return "partial";
  }
  if (counts.blocked > 0) {
    return "blocked";
  }
  return "skipped";
}

function assertPolicyCapsForAmount(
  walletId: number,
  amount: bigint,
  checkVelocity: boolean,
): void {
  assertWithinNetworkValueLimit(amount);
  assertWithinConfiguredValueLimit(amount);
  if (checkVelocity) {
    assertWithinVelocityLimit(walletId, amount);
  }
}

async function waitForPriorConfirmation(
  provider: ReturnType<typeof getProvider>,
  txHash: string,
): Promise<{ confirmed: boolean; reason?: string }> {
  const waitFn = (
    provider as unknown as {
      waitForTransaction?: (
        hash: string,
        confirmations?: number,
        timeout?: number,
      ) => Promise<{ status?: number | null } | null>;
    }
  ).waitForTransaction;

  if (typeof waitFn !== "function") {
    return { confirmed: false };
  }

  try {
    const receipt = await waitFn.call(provider, txHash, 1, CONFIRM_TIMEOUT_MS);
    if (!receipt) {
      return {
        confirmed: false,
        reason: `Timed out waiting for prior step ${txHash} to confirm before sweeping ETH`,
      };
    }
    if (receipt.status === 0) {
      return {
        confirmed: false,
        reason: `Prior transaction ${txHash} reverted on chain; skipping ETH sweep`,
      };
    }
    return { confirmed: true };
  } catch (error) {
    return {
      confirmed: false,
      reason: `Could not confirm prior step ${txHash} before sweeping ETH: ${errorMessage(error)}`,
    };
  }
}

function summarizeReport(
  plans: readonly InternalWalletPlan[],
  toAddress: string,
  request: SweepRequest,
  relayer: Relayer,
  notes: readonly string[],
): SweepReport {
  let walletsWithActions = 0;
  let stepsReady = 0;
  let stepsBroadcast = 0;
  let stepsSkipped = 0;
  let stepsBlocked = 0;
  let stepsFailed = 0;
  let totalEthWei = 0n;

  const tokenAccum = new Map<
    string,
    {
      contract: string;
      symbol: string | null;
      decimals: number | null;
      unwrapRaw: bigint;
      transferRaw: bigint;
    }
  >();

  const wallets: WalletSweepResult[] = plans.map((plan) => {
    const stepResults = plan.steps.map((step) => step.result);
    const status = deriveWalletStatus(stepResults, request.broadcast);

    if (
      stepResults.some(
        (step) => step.status === "ready" || step.status === "broadcast",
      )
    ) {
      walletsWithActions += 1;
    }

    for (const step of stepResults) {
      if (step.status === "ready") stepsReady += 1;
      if (step.status === "broadcast") stepsBroadcast += 1;
      if (step.status === "skipped") stepsSkipped += 1;
      if (step.status === "blocked") stepsBlocked += 1;
      if (step.status === "failed") stepsFailed += 1;

      const active = step.status === "ready" || step.status === "broadcast";
      if (!active) {
        continue;
      }

      const amount = BigInt(step.amountRaw);
      if (step.kind === "eth") {
        totalEthWei += amount;
        continue;
      }

      if (step.contract) {
        const entry = tokenAccum.get(step.contract) ?? {
          contract: step.contract,
          symbol: step.symbol,
          decimals: step.decimals,
          unwrapRaw: 0n,
          transferRaw: 0n,
        };
        if (step.kind === "unwrap") {
          entry.unwrapRaw += amount;
        } else {
          entry.transferRaw += amount;
        }
        tokenAccum.set(step.contract, entry);
      }
    }

    return {
      index: plan.wallet.index,
      address: plan.wallet.address,
      status,
      nativeWeiBefore: plan.nativeWeiBefore.toString(),
      nativeEthBefore: formatEther(plan.nativeWeiBefore),
      steps: stepResults,
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
  });

  const tokenTotals: SweepTokenTotal[] = [...tokenAccum.values()].map(
    (entry) => ({
      contract: entry.contract,
      symbol: entry.symbol,
      decimals: entry.decimals,
      unwrapRaw: entry.unwrapRaw.toString(),
      unwrapFormatted: formatTokenAmount(entry.unwrapRaw, entry.decimals),
      transferRaw: entry.transferRaw.toString(),
      transferFormatted: formatTokenAmount(entry.transferRaw, entry.decimals),
    }),
  );

  return {
    network: config.network,
    chainId: config.chainId,
    toAddress,
    broadcast: request.broadcast,
    relayer: relayer.name,
    requestedBy: request.actor ?? null,
    summary: {
      walletsScanned: plans.length,
      walletsWithActions,
      stepsReady,
      stepsBroadcast,
      stepsSkipped,
      stepsBlocked,
      stepsFailed,
      totalEthWei: totalEthWei.toString(),
      totalEthFormatted: formatEther(totalEthWei),
      tokenTotals,
    },
    wallets,
    notes: [...notes],
  };
}

export async function createSweep(request: SweepRequest): Promise<SweepReport> {
  if (!request.toAddress || typeof request.toAddress !== "string") {
    throw new BadRequestError("toAddress is required");
  }

  let toAddress: string;
  try {
    toAddress = normalizeDestinationAddress(request.toAddress);
  } catch {
    throw new BadRequestError("Destination address is invalid");
  }

  if (toAddress === ZeroAddress) {
    throw new BadRequestError("Destination address cannot be the zero address");
  }

  assertDestinationAllowed(toAddress);

  const walletIndices = resolveWalletIndices(request.walletIndices);
  const wallets = walletIndices.map((index) => {
    const wallet = getWalletByIndex(index);
    if (!wallet) {
      throw new Error(`Wallet index ${index} does not exist`);
    }
    return wallet;
  });

  const tokensExplicit = request.tokens !== undefined;
  const tokenList = normalizeContractList(
    tokensExplicit ? request.tokens : config.trackedContracts,
    "tokens",
  );
  const explicitUnwrapList = normalizeContractList(
    request.unwrapContracts,
    "unwrapContracts",
  );
  const unwrapRequested =
    request.unwrap === true || explicitUnwrapList.length > 0;

  const unwrapList =
    explicitUnwrapList.length > 0
      ? explicitUnwrapList
      : unwrapRequested
        ? tokenList
        : [];
  const unwrapSet = new Set(unwrapList);

  if (request.unwrap === true && unwrapSet.size === 0) {
    throw new BadRequestError(
      "Cannot unwrap: specify tokens or unwrapContracts, or set TRACKED_CONTRACT",
    );
  }

  const includeNative = request.includeNative ?? true;
  const allContracts = [...new Set([...unwrapList, ...tokenList])];

  if (!includeNative && allContracts.length === 0) {
    throw new BadRequestError(
      "Nothing to sweep: includeNative is false and no token contracts are configured",
    );
  }

  const provider = getProvider();
  const callProvider = provider as unknown as CallProvider;
  const relayer = getRelayer(provider);

  const feeData = await provider.getFeeData();
  if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
    throw new Error("Unable to fetch EIP-1559 fee data from provider");
  }
  const maxFeePerGas = feeData.maxFeePerGas;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

  // Read contract metadata once per distinct token contract.
  const metaByContract = new Map<string, ContractMeta>();
  if (allContracts.length > 0) {
    const infos = await Promise.all(
      allContracts.map((contract) => readContractInfo(callProvider, contract)),
    );
    infos.forEach((info, i) => {
      const address = allContracts[i]!;
      metaByContract.set(address, {
        address,
        symbol: info.symbol,
        decimals: info.decimals,
        hubPool: info.hubPool,
        remainingEthReserve:
          info.ethReserveRaw === null ? null : BigInt(info.ethReserveRaw),
      });
    });
  }

  const notes: string[] = [];
  const notedUnreadableImplicit = new Set<string>();
  const plans: InternalWalletPlan[] = [];

  for (const wallet of wallets) {
    if (wallet.address === toAddress) {
      const nativeWei = await provider.getBalance(wallet.address);
      plans.push({
        wallet,
        nativeWeiBefore: nativeWei,
        steps: [],
        reason: "Wallet address is already the destination",
      });
      continue;
    }

    const [nativeWei, startNonce, tokenBalances] = await Promise.all([
      provider.getBalance(wallet.address),
      peekNonce(wallet.index, wallet.address, provider),
      Promise.all(
        allContracts.map((contract) =>
          readTokenBalanceRaw(callProvider, contract, wallet.address),
        ),
      ),
    ]);

    const balanceByContract = new Map<string, bigint | null>();
    allContracts.forEach((contract, i) => {
      balanceByContract.set(contract, tokenBalances[i] ?? null);
    });

    let workingEth = nativeWei;
    let workingNonce = startNonce;
    let priorEthDependent = false;
    const steps: InternalStep[] = [];

    // 1. Unwrap wrapped ETH contracts first so proceeds flow into the ETH sweep.
    for (const contract of unwrapList) {
      const meta = metaByContract.get(contract)!;
      const balance = balanceByContract.get(contract) ?? null;

      if (balance === null) {
        steps.push({
          result: {
            kind: "unwrap",
            status: "blocked",
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            amountRaw: "0",
            amountFormatted: null,
            reason: `Could not read wrapped balance on ${contract} — wrong chain, or contract not deployed`,
          },
        });
        continue;
      }

      if (balance === 0n) {
        steps.push({
          result: {
            kind: "unwrap",
            status: "skipped",
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            amountRaw: "0",
            amountFormatted: formatTokenAmount(0n, meta.decimals),
            reason: "Zero wrapped balance",
          },
        });
        continue;
      }

      // Enforced upfront before any wallet broadcasts.
      assertPolicyCapsForAmount(wallet.id, balance, false);

      if (meta.remainingEthReserve === null || meta.remainingEthReserve < balance) {
        steps.push({
          result: {
            kind: "unwrap",
            status: "blocked",
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            amountRaw: balance.toString(),
            amountFormatted: formatTokenAmount(balance, meta.decimals),
            reason:
              meta.remainingEthReserve === null
                ? `Could not verify ETH backing on ${contract}`
                : `Contract holds ${meta.remainingEthReserve.toString()} wei of ETH, less than the ${balance.toString()} being unwrapped — not fully backed`,
          },
        });
        continue;
      }

      const data = trackedContractInterface.encodeFunctionData(
        UNWRAP_FUNCTION,
        [balance],
      );

      let gasLimit: bigint;
      try {
        gasLimit = await provider.estimateGas({
          from: wallet.address,
          to: contract,
          data,
        });
      } catch (error) {
        steps.push({
          result: {
            kind: "unwrap",
            status: "blocked",
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            amountRaw: balance.toString(),
            amountFormatted: formatTokenAmount(balance, meta.decimals),
            reason: `Gas estimation failed for withdraw(): ${errorMessage(error)}`,
          },
        });
        continue;
      }

      const estimatedGasWei = gasLimit * maxFeePerGas;

      if (relayer.senderPaysGas) {
        const readiness = describeGasReadiness(
          workingEth,
          gasLimit,
          maxFeePerGas,
        );
        if (!readiness.sufficient) {
          steps.push({
            result: {
              kind: "unwrap",
              status: "blocked",
              contract,
              symbol: meta.symbol,
              decimals: meta.decimals,
              amountRaw: balance.toString(),
              amountFormatted: formatTokenAmount(balance, meta.decimals),
              estimatedGasWei: estimatedGasWei.toString(),
              shortfallWei: readiness.shortfallWei.toString(),
              reason: `gas-blocked: ${readiness.message}`,
            },
          });
          continue;
        }
        workingEth -= estimatedGasWei;
      }

      const tx: UnsignedStepTx = {
        to: contract,
        data,
        value: 0n,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
      const nonce = workingNonce++;
      const signed = await signStepTx(wallet.index, tx, nonce);

      workingEth += balance;
      meta.remainingEthReserve -= balance;
      priorEthDependent = true;

      steps.push({
        tx,
        result: {
          kind: "unwrap",
          status: "ready",
          contract,
          symbol: meta.symbol,
          decimals: meta.decimals,
          amountRaw: balance.toString(),
          amountFormatted: formatTokenAmount(balance, meta.decimals),
          gasLimit: gasLimit.toString(),
          maxFeePerGas: maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          estimatedGasWei: estimatedGasWei.toString(),
          nonce,
          txHash: null,
          serialized: signed.serialized,
        },
      });
    }

    // 2. Transfer remaining non-unwrapped ERC-20 tokens.
    for (const contract of tokenList) {
      if (unwrapSet.has(contract)) {
        continue;
      }

      const meta = metaByContract.get(contract)!;
      const balance = balanceByContract.get(contract) ?? null;

      if (balance === null) {
        if (!tokensExplicit) {
          if (!notedUnreadableImplicit.has(contract)) {
            notedUnreadableImplicit.add(contract);
            notes.push(
              `Tracked contract ${contract} returned no balanceOf result on ${config.network} (not deployed on this chain?); token check skipped.`,
            );
          }
          steps.push({
            result: {
              kind: "erc20",
              status: "skipped",
              contract,
              symbol: meta.symbol,
              decimals: meta.decimals,
              amountRaw: "0",
              amountFormatted: null,
              reason: `Not readable on ${config.network}; skipped implicit tracked contract`,
            },
          });
          continue;
        }

        steps.push({
          result: {
            kind: "erc20",
            status: "blocked",
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            amountRaw: "0",
            amountFormatted: null,
            reason: `Could not read balanceOf on ${contract} — wrong chain, or not a token contract`,
          },
        });
        continue;
      }

      if (balance === 0n) {
        steps.push({
          result: {
            kind: "erc20",
            status: "skipped",
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            amountRaw: "0",
            amountFormatted: formatTokenAmount(0n, meta.decimals),
            reason: "Zero token balance",
          },
        });
        continue;
      }

      if (
        meta.hubPool !== null &&
        meta.hubPool.toLowerCase() === toAddress.toLowerCase()
      ) {
        const permitted = await readCanTransferToRestrictedDestination(
          callProvider,
          contract,
          wallet.address,
          meta.hubPool,
        );
        if (permitted !== true) {
          steps.push({
            result: {
              kind: "erc20",
              status: "blocked",
              contract,
              symbol: meta.symbol,
              decimals: meta.decimals,
              amountRaw: balance.toString(),
              amountFormatted: formatTokenAmount(balance, meta.decimals),
              reason:
                permitted === false
                  ? `Transfer to restricted destination (${meta.hubPool}) is blocked while wallet is the pending root-bundle proposer`
                  : `Could not verify transfer eligibility to restricted destination (${meta.hubPool})`,
            },
          });
          continue;
        }
      }

      const data = trackedContractInterface.encodeFunctionData("transfer", [
        toAddress,
        balance,
      ]);

      let gasLimit: bigint;
      try {
        gasLimit = await provider.estimateGas({
          from: wallet.address,
          to: contract,
          data,
        });
      } catch (error) {
        steps.push({
          result: {
            kind: "erc20",
            status: "blocked",
            contract,
            symbol: meta.symbol,
            decimals: meta.decimals,
            amountRaw: balance.toString(),
            amountFormatted: formatTokenAmount(balance, meta.decimals),
            reason: `Gas estimation failed for transfer(): ${errorMessage(error)}`,
          },
        });
        continue;
      }

      const estimatedGasWei = gasLimit * maxFeePerGas;

      if (relayer.senderPaysGas) {
        const readiness = describeGasReadiness(
          workingEth,
          gasLimit,
          maxFeePerGas,
        );
        if (!readiness.sufficient) {
          steps.push({
            result: {
              kind: "erc20",
              status: "blocked",
              contract,
              symbol: meta.symbol,
              decimals: meta.decimals,
              amountRaw: balance.toString(),
              amountFormatted: formatTokenAmount(balance, meta.decimals),
              estimatedGasWei: estimatedGasWei.toString(),
              shortfallWei: readiness.shortfallWei.toString(),
              reason: `gas-blocked: ${readiness.message}`,
            },
          });
          continue;
        }
        workingEth -= estimatedGasWei;
      }

      const tx: UnsignedStepTx = {
        to: contract,
        data,
        value: 0n,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
      const nonce = workingNonce++;
      const signed = await signStepTx(wallet.index, tx, nonce);

      steps.push({
        tx,
        result: {
          kind: "erc20",
          status: "ready",
          contract,
          symbol: meta.symbol,
          decimals: meta.decimals,
          amountRaw: balance.toString(),
          amountFormatted: formatTokenAmount(balance, meta.decimals),
          gasLimit: gasLimit.toString(),
          maxFeePerGas: maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          estimatedGasWei: estimatedGasWei.toString(),
          nonce,
          txHash: null,
          serialized: signed.serialized,
        },
      });
    }

    // 3. Sweep remaining native ETH last.
    if (includeNative) {
      const estimatedGasWei = SIMPLE_TRANSFER_GAS_LIMIT * maxFeePerGas;
      const sweepAmount = workingEth - estimatedGasWei;

      if (workingEth === 0n) {
        steps.push({
          result: {
            kind: "eth",
            status: "skipped",
            contract: null,
            symbol: "ETH",
            decimals: 18,
            amountRaw: "0",
            amountFormatted: "0.0",
            reason: "Zero ETH balance",
          },
        });
      } else if (sweepAmount <= 0n) {
        steps.push({
          result: {
            kind: "eth",
            status: "skipped",
            contract: null,
            symbol: "ETH",
            decimals: 18,
            amountRaw: "0",
            amountFormatted: "0.0",
            estimatedGasWei: estimatedGasWei.toString(),
            reason: `Balance (${formatEther(workingEth)} ETH) does not exceed estimated gas (${formatEther(estimatedGasWei)} ETH)`,
          },
        });
      } else {
        // Enforced upfront across all wallets before any transaction leaves.
        assertPolicyCapsForAmount(wallet.id, sweepAmount, true);

        const tx: UnsignedStepTx = {
          to: toAddress,
          value: sweepAmount,
          gasLimit: SIMPLE_TRANSFER_GAS_LIMIT,
          maxFeePerGas,
          maxPriorityFeePerGas,
        };
        const nonce = workingNonce++;
        const signed = await signStepTx(wallet.index, tx, nonce);

        steps.push({
          tx,
          checkVelocity: true,
          result: {
            kind: "eth",
            status: "ready",
            contract: null,
            symbol: "ETH",
            decimals: 18,
            amountRaw: sweepAmount.toString(),
            amountFormatted: formatEther(sweepAmount),
            ...(priorEthDependent ? { estimatedAfterPriorSteps: true } : {}),
            gasLimit: SIMPLE_TRANSFER_GAS_LIMIT.toString(),
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
            estimatedGasWei: estimatedGasWei.toString(),
            nonce,
            txHash: null,
            serialized: signed.serialized,
          },
        });
      }
    }

    plans.push({
      wallet,
      nativeWeiBefore: nativeWei,
      steps,
    });
  }

  if (!request.broadcast) {
    if (plans.some((plan) => plan.steps.some((step) => step.result.estimatedAfterPriorSteps))) {
      notes.push(
        "Planned ETH sweep amounts after unwrap steps are conservative estimates reserving maxFeePerGas for prior transactions; broadcasting waits for confirmation and sweeps the exact remaining ETH.",
      );
    }
    return summarizeReport(plans, toAddress, request, relayer, notes);
  }

  // Broadcast phase: preflight passed for all wallets, now execute ready steps.
  for (const plan of plans) {
    const wallet = plan.wallet;
    const priorBroadcastHashes: string[] = [];
    let priorUnwrapPending = false;
    let walletAborted = false;
    let walletBroadcastCount = 0;

    for (const step of plan.steps) {
      if (step.result.status !== "ready" || !step.tx) {
        continue;
      }

      if (walletAborted) {
        step.result.status = "blocked";
        step.result.reason =
          "Skipped because an earlier step on this wallet failed or did not confirm";
        continue;
      }

      // If an unwrap just broadcast, wait for confirmation before a dependent
      // token transfer (which may need its ETH for gas). For a final ETH sweep
      // after any token/unwrap step, also wait and re-read the live ETH balance
      // so the sweep catches every wei left on chain.
      const mustWaitForPrior =
        priorBroadcastHashes.length > 0 &&
        (priorUnwrapPending || step.result.kind === "eth");

      if (mustWaitForPrior) {
        const lastHash = priorBroadcastHashes[priorBroadcastHashes.length - 1]!;
        const confirmation = await waitForPriorConfirmation(provider, lastHash);

        if (confirmation.reason) {
          step.result.status = "blocked";
          step.result.reason = confirmation.reason;
          walletAborted = true;
          continue;
        }

        if (confirmation.confirmed) {
          priorUnwrapPending = false;

          if (step.result.kind === "eth") {
            const [liveBalance, liveFees] = await Promise.all([
              provider.getBalance(wallet.address),
              provider.getFeeData(),
            ]);
            const effMaxFee = liveFees.maxFeePerGas ?? step.tx.maxFeePerGas;
            const effPriority =
              liveFees.maxPriorityFeePerGas ?? step.tx.maxPriorityFeePerGas;
            const gasReserve = SIMPLE_TRANSFER_GAS_LIMIT * effMaxFee;
            const exactSweep = liveBalance - gasReserve;

            if (exactSweep <= 0n) {
              step.result.status = "skipped";
              step.result.amountRaw = "0";
              step.result.amountFormatted = "0.0";
              step.result.estimatedGasWei = gasReserve.toString();
              step.result.reason = `Remaining balance (${formatEther(liveBalance)} ETH) after prior steps does not exceed gas (${formatEther(gasReserve)} ETH)`;
              delete step.result.serialized;
              delete step.result.nonce;
              delete step.result.estimatedAfterPriorSteps;
              continue;
            }

            try {
              assertPolicyCapsForAmount(wallet.id, exactSweep, true);
            } catch (error) {
              step.result.status = "blocked";
              step.result.amountRaw = exactSweep.toString();
              step.result.amountFormatted = formatEther(exactSweep);
              step.result.reason = errorMessage(error);
              walletAborted = true;
              continue;
            }

            step.tx = {
              ...step.tx,
              value: exactSweep,
              maxFeePerGas: effMaxFee,
              maxPriorityFeePerGas: effPriority,
            };
            step.result.amountRaw = exactSweep.toString();
            step.result.amountFormatted = formatEther(exactSweep);
            step.result.maxFeePerGas = effMaxFee.toString();
            step.result.maxPriorityFeePerGas = effPriority.toString();
            step.result.estimatedGasWei = gasReserve.toString();
            delete step.result.estimatedAfterPriorSteps;
          }
        }
      }

      const nonce = await allocateNonce(wallet.index, wallet.address, provider);
      const signed = await signStepTx(wallet.index, step.tx, nonce);

      try {
        const { hash } = await relayer.submit(signed.serialized);
        step.result.status = "broadcast";
        step.result.nonce = nonce;
        step.result.txHash = hash;
        step.result.serialized = signed.serialized;
        priorBroadcastHashes.push(hash);
        if (step.result.kind === "unwrap") {
          priorUnwrapPending = true;
        }
        walletBroadcastCount += 1;

        if (step.result.kind === "eth") {
          recordOutflow(
            wallet.id,
            step.result.amountRaw,
            hash,
            request.actor ?? null,
          );
        }
      } catch (error) {
        if (relayer.senderPaysGas) {
          releaseNonce(wallet.index, nonce);
          step.result.reason = errorMessage(error);
        } else {
          step.result.reason =
            `Relay submission failed and it is unknown whether the transaction ` +
            `landed: ${errorMessage(error)}. Check the relay before retrying — ` +
            `reusing nonce ${nonce} risks a duplicate.`;
        }
        step.result.status = "failed";
        step.result.nonce = nonce;
        step.result.serialized = signed.serialized;
        walletAborted = true;
      }
    }

    if (walletBroadcastCount > 0) {
      await syncWalletBalance(wallet);
    }
  }

  return summarizeReport(plans, toAddress, request, relayer, notes);
}
