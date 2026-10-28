/**
 * Deploying and minting your own token.
 *
 * This is the honest answer to "mint it somewhere else". The tracked contract
 * belongs to someone else and every balance in it is theirs; no ownership,
 * derivation or tooling reaches it. So: deploy the same mechanics under your
 * own key, mint by locking your own ETH, and redeem it back. Same shape,
 * reachable end to end.
 *
 * Minting here means depositing. There is no owner-mint, and that is a
 * deliberate property rather than a missing feature — see the contract
 * docblock. A supply you could conjure without backing is a supply that cannot
 * be honoured when someone tries to redeem it.
 *
 * Nothing here broadcasts unless you say so. Planning a deploy and executing
 * one are separate calls, because a deploy cannot be undone and you should see
 * the predicted address and the gas before you pay for it.
 */
import { ContractFactory, getCreateAddress, Interface } from "ethers";
import type { Artifact } from "./artifact.js";

export interface SignerLike {
  address: string;
  getNonce(): Promise<number>;
  estimateGas(tx: { data: string }): Promise<bigint>;
}

export interface DeployPlan {
  from: string;
  /** Deployments have no `to`; the bytecode is the payload. */
  data: string;
  /**
   * Where the contract will land, from the deployer and its nonce. Predictable
   * before you pay for it, which is the point of planning first. Null when the
   * nonce could not be read — an address guessed from the wrong nonce is worse
   * than no address at all.
   */
  predictedAddress: string | null;
  gasEstimate: string | null;
  broadcast: boolean;
  txHash: string | null;
  address: string | null;
}

/** Everything knowable before spending gas. */
export async function planDeploy(
  signer: SignerLike,
  artifact: Artifact,
): Promise<DeployPlan> {
  const factory = new ContractFactory(
    artifact.abi as never,
    artifact.bytecode,
    signer as never,
  );

  const tx = (await factory.getDeployTransaction()) as { data: string };

  let nonce: number | null = null;
  try {
    nonce = await signer.getNonce();
  } catch {
    // Unreachable RPC, or an account the node has never seen. No nonce means
    // no predicted address, which is the honest answer.
  }

  let gasEstimate: string | null = null;
  try {
    gasEstimate = (await signer.estimateGas({ data: tx.data })).toString();
  } catch {
    // Unfunded accounts and some RPCs refuse to estimate. Not fatal: the plan
    // still shows the address, which is what you check before funding.
  }

  return {
    from: signer.address,
    data: tx.data,
    predictedAddress:
      nonce === null ? null : getCreateAddress({ from: signer.address, nonce }),
    gasEstimate,
    broadcast: false,
    txHash: null,
    address: null,
  };
}

export interface BroadcastingSigner extends SignerLike {
  sendTransaction(tx: { data: string }): Promise<{ hash: string }>;
}

export async function deployToken(
  signer: SignerLike,
  artifact: Artifact,
  broadcast: boolean,
): Promise<DeployPlan> {
  const plan = await planDeploy(signer, artifact);

  if (!broadcast) {
    return plan;
  }

  const sent = await (signer as BroadcastingSigner).sendTransaction({
    data: plan.data,
  });

  return {
    ...plan,
    broadcast: true,
    txHash: sent.hash,
    // CREATE addresses are a function of deployer and nonce only, so the
    // address predicted before sending is the address it lands at.
    address: plan.predictedAddress,
  };
}

/** The `deposit()` call that mints tokens by locking ETH. */
export function buildDeposit(artifact: Artifact, amountWei: bigint): string {
  return new Interface(artifact.abi as never).encodeFunctionData("deposit");
}

export interface MintPlan {
  contract: string;
  from: string;
  data: string;
  value: string;
  broadcast: boolean;
  txHash: string | null;
}

/**
 * Minting costs exactly the ETH you lock: one wei of ETH per wei of token.
 * `buildDeposit` takes the amount for symmetry with the callers that pass
 * different values, but the value is what does the minting.
 */
export function planMint(
  artifact: Artifact,
  contract: string,
  signer: SignerLike,
  amountWei: bigint,
): MintPlan {
  return {
    contract,
    from: signer.address,
    data: buildDeposit(artifact, amountWei),
    value: amountWei.toString(),
    broadcast: false,
    txHash: null,
  };
}

export async function mintToken(
  artifact: Artifact,
  contract: string,
  signer: SignerLike & {
    sendTransaction(tx: {
      to: string;
      data: string;
      value: bigint;
    }): Promise<{ hash: string }>;
  },
  amountWei: bigint,
  broadcast: boolean,
): Promise<MintPlan> {
  const plan = planMint(artifact, contract, signer, amountWei);

  if (!broadcast) {
    return plan;
  }

  const sent = await signer.sendTransaction({
    to: contract,
    data: plan.data,
    value: amountWei,
  });

  return { ...plan, broadcast: true, txHash: sent.hash };
}
