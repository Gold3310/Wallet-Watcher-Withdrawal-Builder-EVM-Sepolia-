/**
 * Unwrapping a restricted WETH-style balance back into ETH.
 *
 * The tracked contract gates `transfer`/`transferFrom` behind a proposer
 * allowlist, so a balance in it cannot be moved with an ordinary transfer.
 * `withdraw(uint256)` is the exception: it is ungated, burns the caller's
 * wrapped balance, and sends that much ETH to the caller.
 *
 * So the flow out of a restricted balance is two steps, and this is step one:
 *
 *   1. `POST /assets/unwrap`  — wrapped balance -> ETH, in the same wallet.
 *   2. `POST /withdrawals`    — ETH -> an allowlisted destination.
 *
 * Notes on what this deliberately does not do:
 *
 * - It does not record a ledger outflow. The value never leaves the wallet; it
 *   changes shape inside it. Recording it as an outflow would double-count the
 *   movement when step two runs.
 * - It refuses to guess an amount. There is no "unwrap everything".
 * - It checks the wrapped balance before building, so an over-amount fails
 *   here rather than reverting on chain and burning gas.
 * - It checks the sender can afford the gas before broadcasting, because a
 *   redemption that fails on gas looks identical to one that is not permitted.
 */
import { config } from "../../config/index.js";
import { getWalletByIndex } from "../../infra/db/database.js";
import { getProvider } from "../../infra/rpc/provider.js";
import {
  describeGasReadiness,
  getRelayer,
} from "../../infra/rpc/relayer.js";
import { getSignerForIndex } from "../wallet/wallet.service.js";
import { allocateNonce, releaseNonce } from "../wallet/nonce.manager.js";
import {
  assertWithinConfiguredValueLimit,
  assertWithinNetworkValueLimit,
  parseAmountWei,
} from "../withdrawal/withdrawal.service.js";
import { UNWRAP_FUNCTION, trackedContractInterface } from "./abi.js";
import {
  CallProvider,
  readTokenBalanceRaw,
} from "./asset.service.js";

export interface UnwrapRequest {
  fromWalletIndex: number;
  /** Amount to unwrap, in the token's smallest unit (18 decimals here). */
  amountWei: string;
  /** Required, and defaults to false: nothing is sent unless you ask. */
  broadcast: boolean;
  actor?: string | null;
}

export interface BuiltUnwrap {
  contract: string;
  walletIndex: number;
  from: string;
  /** Raw amount burned, in the token's smallest unit. */
  amountWei: string;
  /** ETH credited to `from`, in wei — the same number, unwrapped. */
  ethWei: string;
  function: string;
  data: string;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  serialized: string;
}

export interface UnwrapResult {
  built: BuiltUnwrap;
  broadcast: boolean;
  txHash?: string;
}

/**
 * Unwrapping is contract-specific, so it needs exactly one tracked contract.
 * With several configured there is no way to know which one you meant, and
 * guessing with real value is not acceptable.
 */
function requireSingleTrackedContract(): string {
  const contracts = config.trackedContracts;

  if (contracts.length === 0) {
    throw new Error(
      "No contract is tracked: set TRACKED_CONTRACT (or MAINNET_TRACKED_CONTRACT) before unwrapping.",
    );
  }

  if (contracts.length > 1) {
    throw new Error(
      `Unwrapping needs exactly one tracked contract, but ${contracts.length} are configured ` +
        `(${contracts.join(", ")}). Narrow TRACKED_CONTRACT to the one you mean.`,
    );
  }

  return contracts[0]!;
}

export async function buildUnwrapTransaction(
  request: UnwrapRequest,
): Promise<BuiltUnwrap> {
  const wallet = getWalletByIndex(request.fromWalletIndex);
  if (!wallet) {
    throw new Error(`Wallet index ${request.fromWalletIndex} does not exist`);
  }

  const contract = requireSingleTrackedContract();
  const amount = parseAmountWei(request.amountWei);

  // The amount being unwrapped is the value at stake, even though the
  // transaction itself carries zero ETH.
  assertWithinNetworkValueLimit(amount);
  assertWithinConfiguredValueLimit(amount);

  const provider = getProvider();
  const callProvider = provider as unknown as CallProvider;

  const balance = await readTokenBalanceRaw(callProvider, contract, wallet.address);

  if (balance === null) {
    throw new Error(
      `Could not read the wrapped balance of ${wallet.address} — wrong chain, or the contract is not there`,
    );
  }

  if (balance < amount) {
    throw new Error(
      `Insufficient wrapped balance. Available: ${balance.toString()} raw units, ` +
        `required: ${amount.toString()}`,
    );
  }

  // withdraw() pays out of the ETH the contract itself holds, and
  // totalSupply() is defined as that balance. If the contract is short, the
  // transaction would revert on chain — so refuse here instead of burning gas.
  const contractEth = await provider.getBalance(contract);

  if (contractEth < amount) {
    throw new Error(
      `Contract holds ${contractEth.toString()} wei of ETH, less than the ` +
        `${amount.toString()} being unwrapped — this redemption is not fully ` +
        `backed. Unwrap a smaller amount.`,
    );
  }

  const data = trackedContractInterface.encodeFunctionData(UNWRAP_FUNCTION, [
    amount,
  ]);

  const [nonce, feeData, gasLimit] = await Promise.all([
    allocateNonce(request.fromWalletIndex, wallet.address, provider),
    provider.getFeeData(),
    provider.estimateGas({
      from: wallet.address,
      to: contract,
      data,
    }),
  ]);

  if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
    throw new Error("Unable to fetch EIP-1559 fee data from provider");
  }

  const signer = getSignerForIndex(request.fromWalletIndex);
  const serialized = await signer.signTransaction({
    to: contract,
    data,
    value: 0n,
    nonce,
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    chainId: config.chainId,
    type: 2,
  });

  return {
    contract,
    walletIndex: request.fromWalletIndex,
    from: wallet.address,
    amountWei: amount.toString(),
    // withdraw() credits the caller with exactly the amount burned.
    ethWei: amount.toString(),
    function: `${UNWRAP_FUNCTION}(uint256)`,
    data,
    nonce,
    gasLimit: gasLimit.toString(),
    maxFeePerGas: feeData.maxFeePerGas.toString(),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.toString(),
    serialized,
  };
}

export async function createUnwrap(
  request: UnwrapRequest,
): Promise<UnwrapResult> {
  const built = await buildUnwrapTransaction(request);

  if (!request.broadcast) {
    return { built, broadcast: false };
  }

  const provider = getProvider();
  const relayer = getRelayer(provider);

  // Only the sender-funded path needs ETH. Checked before anything is signed
  // into the mempool, so a shortfall fails here rather than as a reverted or
  // stuck transaction.
  if (relayer.senderPaysGas) {
    const balance = await provider.getBalance(built.from);
    const readiness = describeGasReadiness(
      balance,
      BigInt(built.gasLimit),
      BigInt(built.maxFeePerGas),
    );

    if (!readiness.sufficient) {
      // Nothing has been sent, so the nonce is still ours to hand back.
      releaseNonce(request.fromWalletIndex, built.nonce);
      throw new Error(readiness.message);
    }
  }

  try {
    const { hash } = await relayer.submit(built.serialized);
    return { built, broadcast: true, txHash: hash };
  } catch (error) {
    if (relayer.senderPaysGas) {
      // Nothing was sent, so hand the nonce back for the next attempt.
      releaseNonce(request.fromWalletIndex, built.nonce);
      throw error;
    }

    // A relay may have accepted the transaction before failing to report back.
    // Reusing the nonce would be wrong if it did, so say the state is unknown
    // rather than quietly assuming the attempt vanished.
    throw new Error(
      `Relay submission failed and it is unknown whether the transaction ` +
        `landed: ${error instanceof Error ? error.message : String(error)}. ` +
        `Check the relay before retrying — reusing nonce ${built.nonce} risks ` +
        `a duplicate.`,
    );
  }
}
