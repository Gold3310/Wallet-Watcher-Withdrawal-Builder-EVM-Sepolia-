import {
  formatEther,
  getAddress,
  isAddress,
  parseEther,
  Transaction,
  TransactionLike,
} from "ethers";
import { config } from "../../config/index.js";
import { getWalletByIndex } from "../../infra/db/database.js";
import { getProvider } from "../../infra/rpc/provider.js";
import { syncWalletBalance } from "../balance/balance.service.js";
import { recordOutflow } from "../ledger/ledger.service.js";
import { getSignerForIndex } from "../wallet/wallet.service.js";

export interface WithdrawalRequest {
  fromWalletIndex: number;
  toAddress: string;
  amountWei: string;
  broadcast: boolean;
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
  const signer = getSignerForIndex(request.fromWalletIndex);
  const provider = getProvider();

  const [nonce, feeData, balance] = await Promise.all([
    provider.getTransactionCount(wallet.address, "pending"),
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
  const response = await provider.broadcastTransaction(built.serialized);

  const wallet = getWalletByIndex(request.fromWalletIndex)!;
  recordOutflow(wallet.id, built.value, response.hash);
  await syncWalletBalance(wallet);

  return {
    built,
    broadcast: true,
    txHash: response.hash,
  };
}
