import {
  formatEther,
  getAddress,
  isAddress,
  parseEther,
  Transaction,
  TransactionLike,
} from "ethers";
import { config } from "../../config/index.js";
import {
  getOutflowTotalSince,
  getWalletByIndex,
} from "../../infra/db/database.js";
import { getProvider } from "../../infra/rpc/provider.js";
import { syncWalletBalance } from "../balance/balance.service.js";
import { recordOutflow } from "../ledger/ledger.service.js";
import { allocateNonce, releaseNonce } from "../wallet/nonce.manager.js";
import { getSignerForIndex } from "../wallet/wallet.service.js";

export interface WithdrawalRequest {
  fromWalletIndex: number;
  toAddress: string;
  amountWei: string;
  broadcast: boolean;
  /** Caller identity from the API token, recorded on the outflow ledger entry. */
  actor?: string | null;
}

export interface BuiltWithdrawal {
  from: string;
  to: string;
  value: string;
  valueEth: string;
  chainId: number;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  hash: string;
  serialized: string;
  signature: {
    r: string;
    s: string;
    v: number;
  };
}

export interface WithdrawalResult {
  built: BuiltWithdrawal;
  broadcast: boolean;
  txHash?: string;
}

const SIMPLE_TRANSFER_GAS_LIMIT = 21_000n;

/**
 * Value ceiling applied on networks where funds are real. Testnets are
 * uncapped. Checked for every withdrawal, whether it comes through
 * `POST /withdrawals` directly or through a permission redemption.
 */
export function assertWithinNetworkValueLimit(value: bigint): void {
  const limit = config.maxTxValueWei;

  if (limit !== null && value > limit) {
    throw new Error(
      `Amount ${value} wei exceeds the ${config.network} per-transaction limit of ${limit} wei`,
    );
  }
}

/** Optional operator-set ceiling, independent of the per-network cap. */
export function assertWithinConfiguredValueLimit(value: bigint): void {
  const limit = config.withdrawalMaxValueWei;

  if (limit !== null && value > limit) {
    throw new Error(
      `Amount ${value} wei exceeds the configured withdrawal limit of ${limit} wei`,
    );
  }
}

/** Destination allowlist. Empty config means unrestricted. */
export function assertDestinationAllowed(toAddress: string): void {
  const allowlist = config.withdrawalAllowlist;

  if (allowlist.length > 0 && !allowlist.includes(toAddress)) {
    throw new Error(`Destination ${toAddress} is not in the withdrawal allowlist`);
  }
}

/**
 * Velocity limit: total outflow per wallet over the trailing window, built-only
 * withdrawals excluded because they never move funds.
 */
export function assertWithinVelocityLimit(
  walletId: number,
  value: bigint,
): void {
  const limit = config.withdrawalMaxPerWindowWei;

  if (limit === null) {
    return;
  }

  const spent = getOutflowTotalSince(walletId, config.withdrawalWindowSeconds);

  if (spent + value > limit) {
    throw new Error(
      `Amount ${value} wei exceeds the remaining withdrawal allowance of ${limit - spent} wei ` +
        `for the last ${config.withdrawalWindowSeconds}s`,
    );
  }
}

export function parseAmountWei(amountWei: string): bigint {
  let value: bigint;

  try {
    value = BigInt(amountWei);
  } catch {
    throw new Error("amountWei must be a valid unsigned integer string");
  }

  if (value <= 0n) {
    throw new Error("Amount must be greater than zero");
  }

  return value;
}

export function parseAmountEth(amountEth: string): bigint {
  return parseEther(amountEth);
}

export function normalizeDestinationAddress(address: string): string {
  if (!isAddress(address)) {
    throw new Error("Destination address is invalid");
  }
  return getAddress(address);
}

export async function buildWithdrawalTransaction(
  request: WithdrawalRequest,
): Promise<BuiltWithdrawal> {
  const wallet = getWalletByIndex(request.fromWalletIndex);
  if (!wallet) {
    throw new Error(`Wallet index ${request.fromWalletIndex} does not exist`);
  }

  const toAddress = normalizeDestinationAddress(request.toAddress);
  const value = parseAmountWei(request.amountWei);

  assertWithinNetworkValueLimit(value);
  assertWithinConfiguredValueLimit(value);
  assertDestinationAllowed(toAddress);
  assertWithinVelocityLimit(wallet.id, value);

  const signer = getSignerForIndex(request.fromWalletIndex);
  const provider = getProvider();

  const [nonce, feeData, balance] = await Promise.all([
    allocateNonce(request.fromWalletIndex, wallet.address, provider),
    provider.getFeeData(),
    provider.getBalance(wallet.address),
  ]);

  if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
    throw new Error("Unable to fetch EIP-1559 fee data from provider");
  }

  const maxFee = feeData.maxFeePerGas;
  const maxPriorityFee = feeData.maxPriorityFeePerGas;
  const totalCost = value + SIMPLE_TRANSFER_GAS_LIMIT * maxFee;

  if (balance < totalCost) {
    throw new Error(
      `Insufficient balance. Available: ${formatEther(balance)} ETH, required: ${formatEther(totalCost)} ETH including gas`,
    );
  }

  const unsignedTx: TransactionLike<string> = {
    type: 2,
    to: toAddress,
    value,
    nonce,
    chainId: config.chainId,
    gasLimit: SIMPLE_TRANSFER_GAS_LIMIT,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriorityFee,
  };

  const signedTx = await signer.signTransaction(unsignedTx);
  const parsedTx = Transaction.from(signedTx);

  if (!parsedTx.signature) {
    throw new Error("Signed transaction is missing signature data");
  }

  return {
    from: wallet.address,
    to: toAddress,
    value: value.toString(),
    valueEth: formatEther(value),
    chainId: config.chainId,
    nonce,
    gasLimit: SIMPLE_TRANSFER_GAS_LIMIT.toString(),
    maxFeePerGas: maxFee.toString(),
    maxPriorityFeePerGas: maxPriorityFee.toString(),
    hash: parsedTx.hash!,
    serialized: signedTx,
    signature: {
      r: parsedTx.signature.r,
      s: parsedTx.signature.s,
      v: parsedTx.signature.v,
    },
  };
}

export async function createWithdrawal(
  request: WithdrawalRequest,
): Promise<WithdrawalResult> {
  const built = await buildWithdrawalTransaction(request);

  if (!request.broadcast) {
    return { built, broadcast: false };
  }

  const provider = getProvider();
  let txHash: string;

  try {
    const response = await provider.broadcastTransaction(built.serialized);
    txHash = response.hash;
  } catch (error) {
    // Nothing was sent, so hand the nonce back for the next attempt.
    releaseNonce(request.fromWalletIndex, built.nonce);
    throw error;
  }

  const wallet = getWalletByIndex(request.fromWalletIndex)!;
  recordOutflow(wallet.id, built.value, txHash, request.actor ?? null);
  await syncWalletBalance(wallet);

  return {
    built,
    broadcast: true,
    txHash,
  };
}
