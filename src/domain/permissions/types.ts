/**
 * ERC-7715 permission types.
 *
 * Shapes follow the `wallet_grantPermissions` RPC documented at
 * https://www.openfort.io/docs/products/cross-app-wallet/rpc/wallet_grantPermissions
 * and the underlying ERC:
 * https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7715.md
 */

export type Hex = `0x${string}`;

export const PERMISSION_TYPES = [
  "contract-call",
  "erc20-token-transfer",
  "erc721-token-transfer",
  "erc1155-token-transfer",
  "native-token-transfer",
] as const;

export type PermissionType = (typeof PERMISSION_TYPES)[number];

export const SIGNER_TYPES = ["key", "account"] as const;

export type SignerType = (typeof SIGNER_TYPES)[number];

/** A single allowed function: either a 4-byte selector or a full signature. */
export interface PermissionCall {
  signature?: string;
}

export interface PermissionData {
  /** Contract (or token) address the permission is scoped to. */
  address?: Hex;
  /** Allowed function calls. */
  calls?: PermissionCall[];
}

export interface Policy {
  type: string;
  data?: Record<string, unknown>;
}

export interface Permission {
  type: PermissionType;
  data: PermissionData;
  policies: Policy[];
}

export interface SignerSpec {
  type: SignerType;
  data: {
    id: Hex;
  };
}

/** `params[0]` of a `wallet_grantPermissions` request. */
export interface GrantPermissionsRequest {
  /** Expiry as a duration in seconds from now. */
  expiry: number;
  signer: SignerSpec;
  permissions: Permission[];
}

/** The `result` of a `wallet_grantPermissions` call. */
export interface GrantPermissionsResponse {
  /** Absolute expiry, unix seconds. */
  expiry: number;
  /** Factory address for the account. */
  factory?: Hex;
  /** Factory data. */
  factoryData?: Hex;
  grantedPermissions: {
    type: string;
    data: Record<string, unknown>;
    policies?: Policy[];
  }[];
  /** ID of the session registered for the signer. */
  permissionsContext: Hex;
  signerData?: {
    userOpBuilder?: Hex;
    submitToAddress?: Hex;
  };
}

export interface SessionStatus {
  state: "active" | "expired" | "revoked";
  remainingSeconds: number;
}

/**
 * Policy types this backend understands and enforces. Any other policy type is
 * still hashed into the permission digest (so it is faithfully recorded in the
 * granted permission) but is NOT enforced here.
 */
export const ENFORCED_POLICY_TYPES = {
  /** Cumulative native value (wei) the session may move, across all redemptions. */
  spendingCap: "spending-cap",
  /** Maximum native value (wei) the session may move in a single redemption. */
  valueLimit: "value-limit",
} as const;
