/**
 * Redeeming an ERC-7715 permission.
 *
 * The spec's redemption path runs through an ERC-7710 delegation manager:
 *
 *     redeemDelegation(bytes[] _permissionContexts,
 *                      bytes32[] _modes,
 *                      bytes[] _executionCallData)
 *
 * where each execution is
 *
 *     struct Execution { address target; uint256 value; bytes callData; }
 *
 * packed as `encodePacked(['address','uint256','bytes'], [...])`.
 *
 * One wrinkle worth recording: the ERC's interface block declares
 * `redeemDelegation` (singular) while its own pseudocode calls
 * `redeemDelegations` (plural). Real deployments differ on this, so both
 * selectors are exposed here and the caller picks the one matching the
 * `delegationManager` it configured. Guessing would produce calldata that
 * silently reverts.
 *
 * Nothing here broadcasts. It returns the calldata; sending it is the caller's
 * decision, made elsewhere.
 */
import { Interface, solidityPacked, ZeroHash } from "ethers";
import { BadRequestError } from "../../util/errors.js";
import type { Hex } from "./erc7715.js";

export const REDEEM_DELEGATION_ABI = [
  "function redeemDelegation(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallData) external",
  "function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallData) external",
] as const;

export const redeemDelegationInterface = new Interface(
  REDEEM_DELEGATION_ABI as unknown as string[],
);

/**
 * Execution modes. `SingleDefault` — one execution, run as given — is the only
 * mode this builder constructs, expressed as 32 zero bytes.
 */
export const EXECUTION_MODES = {
  singleDefault: ZeroHash,
} as const;

export interface Execution {
  target: Hex;
  value: bigint;
  callData: Hex;
}

export function encodeExecution(execution: Execution): Hex {
  return solidityPacked(
    ["address", "uint256", "bytes"],
    [execution.target, execution.value, execution.callData],
  ) as Hex;
}

export interface RedeemDelegationInput {
  delegationManager: Hex;
  /** One context per permission being redeemed, straight from the response. */
  contexts: Hex[];
  /** One mode per context. Defaults to SingleDefault for each. */
  modes?: Hex[];
  /** One execution per context: what the grantor's account should emit. */
  executions: Execution[];
  /** Which spelling the configured delegation manager uses. */
  method?: "redeemDelegation" | "redeemDelegations";
}

export interface BuiltTransaction {
  to: Hex;
  data: Hex;
  method: string;
}

export function buildRedeemDelegation(
  input: RedeemDelegationInput,
): BuiltTransaction {
  const { contexts, executions } = input;

  if (contexts.length === 0) {
    throw new BadRequestError("At least one permission context is required");
  }

  // Three parallel arrays, mismatched only by mistake — and a mismatched call
  // is a revert at best, so it is refused here instead.
  if (executions.length !== contexts.length) {
    throw new BadRequestError(
      `Expected ${contexts.length} execution(s) to match ${contexts.length} ` +
        `permission context(s), received ${executions.length}`,
    );
  }

  const modes = input.modes ?? contexts.map(() => EXECUTION_MODES.singleDefault);

  if (modes.length !== contexts.length) {
    throw new BadRequestError(
      `Expected ${contexts.length} execution mode(s), received ${modes.length}`,
    );
  }

  const method = input.method ?? "redeemDelegation";

  return {
    to: input.delegationManager,
    method,
    data: redeemDelegationInterface.encodeFunctionData(method, [
      contexts,
      modes,
      executions.map(encodeExecution),
    ]) as Hex,
  };
}

/** Convenience for the common case: one permission, one execution. */
export function buildSingleRedemption(
  delegationManager: Hex,
  context: Hex,
  execution: Execution,
  method?: RedeemDelegationInput["method"],
): BuiltTransaction {
  return buildRedeemDelegation({
    delegationManager,
    contexts: [context],
    executions: [execution],
    ...(method === undefined ? {} : { method }),
  });
}
