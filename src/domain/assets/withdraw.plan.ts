/**
 * Plan a withdrawal from a named address, and say plainly whether it can be
 * signed here.
 *
 * `withdraw(uint256)` burns the *caller's own* balance. Nobody can redeem
 * someone else's ABT — not this service, not the owner, not a relayer. So the
 * first question is always the same: can this service sign for the address
 * named?
 *
 * When it can, the answer is a service route. When it cannot, the honest
 * answer is not a workaround but a **signing kit**: the exact transaction the
 * holder of that address must sign in their own wallet. Preparing a
 * transaction is not signing one, and the calldata is public information
 * anyway — contract, selector, and amount.
 *
 * What this deliberately will not do: accept a private key to make the
 * problem go away, or infer one. If the key is not derivable from
 * `WALLET_MNEMONIC`, the plan says so and stops.
 */
import { getAddress } from "ethers";
import { config } from "../../config/index.js";
import { trackedContractInterface } from "./abi.js";
import { deriveConfiguredWallets } from "../wallet/wallet.service.js";

export interface WithdrawalPlanInput {
  /** The address whose ABT balance would be burned. */
  from: string;
  /** Amount in the token's smallest unit (18 decimals). */
  amountWei: string;
  /** Defaults to the configured chain. Set explicitly for mainnet. */
  chainId?: number;
}

export interface UnsignedWithdrawal {
  to: string;
  data: string;
  /** Always "0": withdraw is not payable. */
  value: string;
  chainId: number;
}

export interface WithdrawalPlan {
  from: string;
  contract: string;
  amountWei: string;
  /** Null when the balance could not be read — unknown, never zero. */
  balance: string | null;
  /** Null when the balance is unknown. */
  sufficient: boolean | null;
  /** Whether this service holds a key for `from`. */
  canSignHere: boolean;
  /** Derived-wallet index, when it does. */
  walletIndex: number | null;
  /** Where the signature has to come from. */
  route: "service" | "external";
  transaction: UnsignedWithdrawal;
  /** Reasons this cannot be executed here. Empty when it can. */
  blockers: string[];
  /** What to actually do, in order. */
  instructions: string[];
}

/**
 * Which derived wallet (if any) matches an address. Derivation is offline and
 * deterministic, so this needs no chain access.
 */
export function findWalletIndex(address: string): number | null {
  let target: string;
  try {
    target = getAddress(address);
  } catch {
    return null;
  }

  const index = deriveConfiguredWallets().findIndex(
    (wallet) => wallet.address === target,
  );

  return index === -1 ? null : index;
}

export async function planWithdrawal(
  provider: { call(tx: { to: string; data: string }): Promise<string> },
  contract: string,
  input: WithdrawalPlanInput,
): Promise<WithdrawalPlan> {
  let amount: bigint;
  try {
    amount = BigInt(input.amountWei);
  } catch {
    throw new Error(
      `amountWei must be an integer in the token's smallest unit, got "${input.amountWei}"`,
    );
  }

  if (amount <= 0n) {
    throw new Error("amountWei must be greater than zero");
  }

  let from: string;
  try {
    from = getAddress(input.from);
  } catch {
    throw new Error(`"${input.from}" is not a valid address`);
  }

  const chainId = input.chainId ?? config.chainId;
  const walletIndex = findWalletIndex(from);
  const canSignHere = walletIndex !== null;

  // Balance, read from the public getter. Unreadable stays unknown.
  let balance: bigint | null = null;
  try {
    const result = await provider.call({
      to: contract,
      data: trackedContractInterface.encodeFunctionData("balanceOf", [from]),
    });
    balance = trackedContractInterface.decodeFunctionResult(
      "balanceOf",
      result,
    )[0] as bigint;
  } catch {
    balance = null;
  }

  const sufficient = balance === null ? null : balance >= amount;

  const transaction: UnsignedWithdrawal = {
    to: contract,
    data: trackedContractInterface.encodeFunctionData("withdraw", [amount]),
    value: "0",
    chainId,
  };

  const blockers: string[] = [];
  const instructions: string[] = [];

  if (balance === null) {
    blockers.push(
      `The ABT balance of ${from} could not be read. Nothing is concluded ` +
        `about whether the withdrawal would succeed — an unreadable balance ` +
        `is not a zero balance.`,
    );
  } else if (sufficient === false) {
    blockers.push(
      `${from} holds ${balance.toString()} units, which is less than the ` +
        `${amount.toString()} requested. withdraw() burns the caller's own ` +
        `balance and reverts if it is short.`,
    );
  }

  if (canSignHere) {
    instructions.push(
      `This service can sign for ${from} (derived wallet ${walletIndex}). ` +
        `Build it first, inspect the calldata, then broadcast:`,
    );
    instructions.push(
      `curl -X POST http://localhost:3000/assets/unwrap \\\n` +
        `  -H 'x-api-token: <token>' -H 'content-type: application/json' \\\n` +
        `  -d '{"fromWalletIndex":${walletIndex},"amountWei":"${amount.toString()}","broadcast":false}'`,
    );
    instructions.push(
      `Then repeat with "broadcast":true once the built transaction looks right.`,
    );
  } else {
    blockers.push(
      `${from} is not a wallet derived from WALLET_MNEMONIC, so this service ` +
        `has no key for it and cannot sign the withdrawal. withdraw() burns ` +
        `the caller's own balance: nobody can redeem another address's ABT — ` +
        `not this service, not the contract owner, not a relayer.`,
    );
    instructions.push(
      `Only the holder of ${from} can redeem this. Sign the transaction below ` +
        `in whatever wallet controls that address (MetaMask, Ledger, a ` +
        `hardware wallet, or your own script):`,
    );
    instructions.push(
      `  to:    ${transaction.to}\n` +
        `  data:  ${transaction.data}\n` +
        `  value: ${transaction.value}\n` +
        `  chain: ${transaction.chainId}`,
    );
    instructions.push(
      `Gas comes from the same address, so it needs ETH for gas separately ` +
        `from the ABT being burned.`,
    );
    instructions.push(
      `This service will not accept a private key to do it for you. If the ` +
        `key is not derivable from WALLET_MNEMONIC, there is no path here.`,
    );
  }

  return {
    from,
    contract,
    amountWei: amount.toString(),
    balance: balance === null ? null : balance.toString(),
    sufficient,
    canSignHere,
    walletIndex,
    route: canSignHere ? "service" : "external",
    transaction,
    blockers,
    instructions,
  };
}
