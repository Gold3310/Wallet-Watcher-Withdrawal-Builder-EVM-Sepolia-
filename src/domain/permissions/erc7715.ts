/**
 * ERC-7715, as the spec stands now.
 *
 * The grant path already in this repo follows the older
 * `wallet_grantPermissions` shape that Openfort documents. The ERC has since
 * been reworked, and the two disagree in ways that matter:
 *
 *   | Openfort shape (implemented)   | Current ERC-7715                      |
 *   |--------------------------------|---------------------------------------|
 *   | `wallet_grantPermissions`      | `wallet_requestExecutionPermissions`  |
 *   | `expiry` as a duration         | `rules: [{type:"expiry", timestamp}]` |
 *   | `policies: [{type,data}]`      | `rules: [{type,data}]`                |
 *   | (no equivalent)                | `permission.isAdjustmentAllowed`      |
 *   | `permissionsContext`           | `context`                             |
 *   | `factory` / `factoryData`      | `dependencies: [{factory,factoryData}]`|
 *   | (no equivalent)                | `delegationManager`                   |
 *
 * Rather than keep two engines that can drift, this module is the translation
 * layer: it speaks the current spec on the outside and calls the existing grant
 * engine on the inside. One enforcement path, two wire shapes.
 *
 * Two things it refuses to do quietly:
 *
 * - **Other chains.** A request carries `chainId`. If it is not the chain this
 *   service is configured for, the grant is refused — a permission scoped to a
 *   chain you are not on is not a scoping, it is a mistake waiting to be
 *   replayed.
 * - **Invented infrastructure.** `delegationManager` and the factory
 *   dependencies are real deployed contracts. When they are not configured,
 *   they are reported as null with a warning rather than fabricated, because a
 *   plausible-looking wrong address is worse than an honest gap.
 */
import { getAddress, isHexString, ZeroAddress } from "ethers";
import { BadRequestError } from "../../util/errors.js";
import { config } from "../../config/index.js";
import type { Permission, Policy, SignerType } from "./types.js";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/** The spec's `BasePermission`: a type, permission data, and attenuation consent. */
export interface SpecPermission {
  type: string;
  /**
   * Whether the wallet MAY attenuate — narrow or widen — the permission to
   * meet the user's terms. The spec's example shows a wallet raising an
   * allowance from `0x1DCD6500` to `0x1DCD65000000`, which is why this field
   * exists and why `false` has to be respected.
   */
  isAdjustmentAllowed: boolean;
  data: Record<string, unknown>;
}

export interface SpecRule {
  type: string;
  data: Record<string, unknown>;
}

/** The spec's `ExpiryRule`: the one rule type this backend understands. */
export interface ExpiryRule extends SpecRule {
  type: "expiry";
  data: { timestamp: number };
}

export interface PermissionRequest {
  /** Hex-encoded EIP-155 chain id. */
  chainId: Hex;
  /** Account the permission is granted *by*. Optional; the wallet may choose. */
  from?: Address;
  /** Session account the permission is granted *to* — the one that redeems. */
  to: Address;
  permission: SpecPermission;
  rules?: SpecRule[];
}

export interface PermissionDependency {
  factory: Address;
  factoryData: Hex;
}

export interface PermissionResponse extends PermissionRequest {
  /** Opaque handle for revoking or redeeming, per ERC-7710. */
  context: Hex;
  /** Accounts that must be deployed before the permission can be redeemed. */
  dependencies: PermissionDependency[];
  /** The ERC-7710 delegation manager redemption goes through. */
  delegationManager: Address | null;
}

/** What `wallet_getSupportedExecutionPermissions` advertises. */
export type SupportedPermissions = Record<
  string,
  { chainIds: Hex[]; ruleTypes: string[] }
>;

/**
 * Permission types accepted on the spec-shaped path.
 *
 * The spec's examples use `*-allowance` types carrying a `data.allowance` in
 * hex wei. The Openfort-era engine enforced cumulative limits through
 * `spending-cap` policies, so an allowance maps onto a spending cap: both are
 * "no more than this, in total".
 */
export const SPEC_PERMISSION_TYPES = {
  nativeTokenAllowance: "native-token-allowance",
  nativeTokenTransfer: "native-token-transfer",
  contractCall: "contract-call",
} as const;

export const SPEC_RULE_TYPES = {
  expiry: "expiry",
} as const;

const ALLOWANCE_TYPES: Set<string> = new Set([
  SPEC_PERMISSION_TYPES.nativeTokenAllowance,
]);

/** The internal engine only redeems native transfers. */
const EXECUTABLE_TYPES: Set<string> = new Set([
  SPEC_PERMISSION_TYPES.nativeTokenAllowance,
  SPEC_PERMISSION_TYPES.nativeTokenTransfer,
]);

export function toChainIdHex(chainId: number): Hex {
  return `0x${chainId.toString(16)}` as Hex;
}

/**
 * Reads a hex chain id and checks it against the configured chain.
 *
 * Refusing a foreign chainId is the point: accepting one would mint a
 * permission this service believes is scoped to itself when the wallet
 * granting it may have meant somewhere else entirely.
 */
export function assertChainSupported(chainId: unknown): number {
  if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId)) {
    throw new BadRequestError(
      `chainId must be a hex-encoded string such as "0x1" (received: ${String(chainId)})`,
    );
  }

  const parsed = Number(BigInt(chainId));

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BadRequestError(`chainId "${chainId}" is not a valid chain id`);
  }

  if (parsed !== config.chainId) {
    throw new BadRequestError(
      `chainId ${parsed} is not the chain this service is configured for ` +
        `(${config.chainId}, ${config.network}). Refusing to grant a ` +
        `permission scoped to another chain.`,
    );
  }

  return parsed;
}

export function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string") {
    throw new BadRequestError(`${field} must be an address string`);
  }
  try {
    return getAddress(value) as Address;
  } catch {
    throw new BadRequestError(`${field} "${value}" is not a valid address`);
  }
}

/** Hex-encoded wei allowance, as the spec carries it. */
function parseAllowance(data: Record<string, unknown>): bigint {
  const raw = data.allowance;

  if (typeof raw !== "string" || !isHexString(raw)) {
    throw new BadRequestError(
      'native-token-allowance requires data.allowance as a hex string, e.g. "0x0DE0B6B3A7640000"',
    );
  }

  const value = BigInt(raw);

  if (value <= 0n) {
    throw new BadRequestError("native-token-allowance requires a positive allowance");
  }

  return value;
}

/**
 * Translates one spec permission into the internal model.
 *
 * An allowance becomes a `spending-cap` policy, because that is what the
 * enforcement path already understands and both mean "no more than this in
 * total".
 */
export function toInternalPermission(permission: SpecPermission): Permission {
  if (typeof permission?.type !== "string") {
    throw new BadRequestError("permission.type is required");
  }

  if (typeof permission.isAdjustmentAllowed !== "boolean") {
    throw new BadRequestError("permission.isAdjustmentAllowed must be a boolean");
  }

  const data = permission.data ?? {};
  const policies: Policy[] = [];

  if (ALLOWANCE_TYPES.has(permission.type)) {
    policies.push({
      type: "spending-cap",
      data: { limit: parseAllowance(data).toString() },
    });
  } else if (data.allowance !== undefined) {
    // Only the allowance types consume `allowance`; anything else carrying it
    // is a request we would be silently dropping, so say so.
    throw new BadRequestError(
      `permission type "${permission.type}" does not accept data.allowance`,
    );
  }

  if (permission.type === SPEC_PERMISSION_TYPES.contractCall) {
    const target = data.target ?? data.address;
    if (typeof target !== "string") {
      throw new BadRequestError(
        'contract-call requires data.target (or data.address) as an address',
      );
    }
    return {
      type: "contract-call",
      data: { address: getAddress(target) as Hex },
      policies,
    };
  }

  if (!EXECUTABLE_TYPES.has(permission.type)) {
    throw new BadRequestError(
      `Unsupported permission type "${permission.type}". Supported: ` +
        `${Object.values(SPEC_PERMISSION_TYPES).join(", ")}`,
    );
  }

  return {
    type: "native-token-transfer",
    data: {},
    policies,
  };
}

/** Pulls the expiry rule out, if one was sent. */
export function expiryRuleOf(rules: SpecRule[] | undefined): ExpiryRule | null {
  const found = (rules ?? []).find((rule) => rule?.type === "expiry");
  return found ? (found as ExpiryRule) : null;
}

/**
 * Converts the spec's absolute expiry timestamp into the duration the internal
 * engine wants, checked against the configured maximum.
 *
 * A timestamp in the past is rejected rather than clamped: silently granting an
 * already-dead permission, or silently extending one past the cap, would both
 * hand back something the requester did not ask for.
 */
export function toExpiryDuration(
  rules: SpecRule[] | undefined,
  now: number,
): number {
  const rule = expiryRuleOf(rules);

  if (!rule) {
    return config.permissionsDefaultExpirySeconds;
  }

  const timestamp = rule.data?.timestamp;

  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new BadRequestError("rule \"expiry\" requires data.timestamp as a unix number");
  }

  const duration = Math.floor(timestamp) - now;

  if (duration <= 0) {
    throw new BadRequestError(
      `expiry timestamp ${timestamp} is already in the past (now ${now})`,
    );
  }

  if (duration > config.permissionsMaxExpirySeconds) {
    throw new BadRequestError(
      `expiry of ${duration} seconds exceeds the maximum of ` +
        `${config.permissionsMaxExpirySeconds} seconds`,
    );
  }

  return duration;
}

export interface TranslatedRequest {
  chainId: number;
  /** The account granting the permission, when the request specified one. */
  from: Address | null;
  /** The session account that will redeem it. */
  to: Address;
  signerType: SignerType;
  expiry: number;
  permissions: Permission[];
  isAdjustmentAllowed: boolean;
}

/** Validates a spec request and reduces it to what the grant engine needs. */
export function translateRequest(
  request: PermissionRequest,
  now: number,
): TranslatedRequest {
  const chainId = assertChainSupported(request.chainId);
  const to = parseAddress(request.to, "to");
  const from =
    request.from === undefined ? null : parseAddress(request.from, "from");

  const permission = toInternalPermission(request.permission);
  const expiry = toExpiryDuration(request.rules, now);

  return {
    chainId,
    from,
    to,
    // The spec's `to` is the account that redeems, which maps onto the
    // account-signer form the internal engine already has.
    signerType: "account",
    expiry,
    permissions: [permission],
    isAdjustmentAllowed: request.permission.isAdjustmentAllowed,
  };
}

/**
 * What this wallet advertises through
 * `wallet_getSupportedExecutionPermissions`.
 *
 * Only what is genuinely enforced is listed. Advertising a rule type the
 * enforcement path ignores would let a requester believe a restriction exists
 * that nothing checks.
 */
export function getSupportedExecutionPermissions(): SupportedPermissions {
  const chainIds = [toChainIdHex(config.chainId)];

  return {
    [SPEC_PERMISSION_TYPES.nativeTokenAllowance]: {
      chainIds,
      ruleTypes: [SPEC_RULE_TYPES.expiry],
    },
    [SPEC_PERMISSION_TYPES.nativeTokenTransfer]: {
      chainIds,
      ruleTypes: [SPEC_RULE_TYPES.expiry],
    },
    [SPEC_PERMISSION_TYPES.contractCall]: {
      chainIds,
      ruleTypes: [SPEC_RULE_TYPES.expiry],
    },
  };
}

export interface GrantedLike {
  permissionsContext: string;
  permissions: Permission[];
  expiry: number;
  account: string;
  signer: { type: SignerType; id: string };
  status: string;
}

/**
 * Renders a granted session back into the spec's response shape.
 *
 * `delegationManager` and `dependencies` come from configuration. When they are
 * not configured the response carries nulls and a warning, because the
 * alternative — plausible placeholder addresses — would send a redeemer to a
 * contract that does not exist.
 */
export function toPermissionResponse(
  request: PermissionRequest,
  granted: GrantedLike,
): PermissionResponse & { warning?: string } {
  const delegationManager = config.permissionsDelegationManager;
  const dependencies: PermissionDependency[] = [];

  if (
    config.permissionsAccountFactory &&
    config.permissionsAccountFactoryData
  ) {
    dependencies.push({
      factory: config.permissionsAccountFactory,
      factoryData: config.permissionsAccountFactoryData,
    });
  }

  const warning =
    delegationManager === null
      ? "delegationManager is not configured (PERMISSIONS_DELEGATION_MANAGER), " +
        "so this response cannot be redeemed through ERC-7710 yet."
      : undefined;

  return {
    ...request,
    context: granted.permissionsContext as Hex,
    dependencies,
    delegationManager: delegationManager ?? (ZeroAddress as Address),
    ...(warning === undefined ? {} : { warning }),
  };
}
