/**
 * ERC-7715 permission granting and redemption.
 *
 * Granting (`wallet_grantPermissions`) registers a session signer on an account
 * together with the permissions and policies that bound what it may do. This
 * service:
 *
 *   1. builds the exact `wallet_grantPermissions` request/response payloads,
 *   2. derives an ephemeral session key and persists the grant,
 *   3. re-derives that session key to authorise (and execute) redemptions,
 *      enforcing expiry and the policies it understands.
 *
 * Deviation from a full smart-account ERC-7715 flow: the accounts here are
 * plain EOAs derived from the HD mnemonic, so there is no on-chain permission
 * validator to redeem against. The session key therefore authorises the action
 * by signing the action digest, and this backend — which checks the grant,
 * expiry and policies before it will sign anything — executes it with the
 * account key. The account key never leaves the process.
 */
import { randomBytes } from "node:crypto";
import {
  concat,
  getBytes,
  keccak256,
  verifyMessage,
  Wallet,
} from "ethers";
import { config } from "../../config/index.js";
import {
  getPermissionSessionByContext,
  getPermissionSessionById,
  getPermissionSessions,
  getWalletById,
  getWalletByIndex,
  insertPermissionSession,
  PermissionSessionRow,
  releaseSessionSpend,
  reserveSessionSpend,
  revokePermissionSession,
} from "../../infra/db/database.js";
import { canonicalJson } from "../../util/canonical.js";
import { deriveWalletAtIndex } from "../wallet/wallet.service.js";
import {
  createWithdrawal,
  normalizeDestinationAddress,
  parseAmountWei,
  WithdrawalResult,
} from "../withdrawal/withdrawal.service.js";
import {
  buildActionDigest,
  buildGrantDigest,
  decodePermissionsContext,
  encodePermissionsContext,
  hashPermissions,
  hashSigner,
} from "./encoding.js";
import {
  ENFORCED_POLICY_TYPES,
  GrantPermissionsRequest,
  GrantPermissionsResponse,
  Hex,
  PERMISSION_TYPES,
  Permission,
  Policy,
  SignerSpec,
  SignerType,
} from "./types.js";

export interface GrantInput {
  fromWalletIndex: number;
  /** Duration in seconds from now. Defaults to `PERMISSIONS_DEFAULT_EXPIRY_SECONDS`. */
  expiry?: number;
  permissions: Permission[];
  signerType?: SignerType;
  /** Optional explicit session key. A fresh one is derived when omitted. */
  sessionSeed?: string;
}

export interface GrantResult {
  request: GrantPermissionsRequest;
  response: GrantPermissionsResponse;
  session: PermissionSessionView;
}

export interface RedeemInput {
  sessionId: number;
  toAddress: string;
  amountWei: string;
  broadcast: boolean;
  /** Caller identity from the API token, recorded on the outflow ledger entry. */
  actor?: string | null;
}

export interface RedeemResult {
  session: PermissionSessionView;
  authorization: {
    actionDigest: Hex;
    nonce: number;
    sessionKeySignature: Hex;
    recoveredSigner: string;
  };
  withdrawal: WithdrawalResult;
}

export interface PermissionSessionView {
  id: number;
  walletIndex: number;
  account: string;
  status: "active" | "expired" | "revoked";
  signer: { type: SignerType; id: string };
  /** Absolute expiry, unix seconds. */
  expiry: number;
  expiresAt: string;
  grantedAt: string;
  remainingSeconds: number;
  permissions: Permission[];
  permissionsHash: string;
  permissionsContext: string;
  grantDigest: string;
  grantSignature: string;
  spentWei: string;
  /** Remaining allowance under the strictest `spending-cap`, null when unbounded. */
  remainingWei: string | null;
  nonce: number;
  revokedAt: string | null;
}

const EXECUTABLE_PERMISSION_TYPE = "native-token-transfer";
const NATIVE_TRANSFER_CALLDATA: Hex = "0x";

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Session keys are never written to disk. A random seed is stored instead, and
 * the key is this KDF of the account key and that seed — so a database leak on
 * its own yields nothing without the mnemonic.
 */
export function deriveSessionWallet(
  accountPrivateKey: string,
  sessionSeed: string,
): Wallet {
  const privateKey = keccak256(
    concat([getBytes(accountPrivateKey), getBytes(sessionSeed)]),
  );
  return new Wallet(privateKey);
}

export function validatePermissions(permissions: unknown): Permission[] {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new Error("permissions must be a non-empty array");
  }

  return permissions.map((entry, position) => {
    const permission = entry as Partial<Permission>;

    if (!permission || typeof permission.type !== "string") {
      throw new Error(`permissions[${position}].type is required`);
    }

    if (!PERMISSION_TYPES.includes(permission.type as never)) {
      throw new Error(
        `permissions[${position}].type must be one of: ${PERMISSION_TYPES.join(", ")}`,
      );
    }

    if (!Array.isArray(permission.policies)) {
      throw new Error(`permissions[${position}].policies must be an array`);
    }

    return {
      type: permission.type,
      data: permission.data ?? {},
      policies: permission.policies as Policy[],
    };
  });
}

export function validateExpiry(expiry: unknown): number {
  if (expiry === undefined) {
    return config.permissionsDefaultExpirySeconds;
  }

  if (typeof expiry !== "number" || !Number.isInteger(expiry) || expiry <= 0) {
    throw new Error("expiry must be a positive integer number of seconds");
  }

  if (expiry > config.permissionsMaxExpirySeconds) {
    throw new Error(
      `expiry must not exceed ${config.permissionsMaxExpirySeconds} seconds`,
    );
  }

  return expiry;
}

export function grantPermissions(input: GrantInput): GrantResult {
  const wallet = getWalletByIndex(input.fromWalletIndex);
  if (!wallet) {
    throw new Error(`Wallet index ${input.fromWalletIndex} does not exist`);
  }

  const permissions = validatePermissions(input.permissions);
  const durationSeconds = validateExpiry(input.expiry);

  if (!config.allowUnboundedGrants && spendingCapOf(permissions) === null) {
    throw new Error(
      `Grants on ${config.network} must declare a '${ENFORCED_POLICY_TYPES.spendingCap}' policy, ` +
        "or set MAINNET_ALLOW_UNBOUNDED_GRANTS=true to accept unbounded sessions",
    );
  }

  const accountWallet = deriveWalletAtIndex(
    config.walletMnemonic,
    input.fromWalletIndex,
  );

  if (accountWallet.address !== wallet.address) {
    throw new Error(
      `Derived address for index ${input.fromWalletIndex} no longer matches the persisted address`,
    );
  }

  const sessionSeed =
    input.sessionSeed ?? (`0x${randomBytes(32).toString("hex")}` as Hex);
  const sessionWallet = deriveSessionWallet(accountWallet.privateKey, sessionSeed);

  const signerType: SignerType = input.signerType ?? "key";
  const signer: SignerSpec = {
    type: signerType,
    data: { id: sessionWallet.address as Hex },
  };

  const grantedAt = nowSeconds();
  const expiry = grantedAt + durationSeconds;
  const permissionsHash = hashPermissions(permissions);

  const request: GrantPermissionsRequest = {
    expiry: durationSeconds,
    signer,
    permissions,
  };

  const grantDigest = buildGrantDigest({
    account: wallet.address,
    signer,
    expiry,
    permissionsHash,
  });

  const permissionsContext = encodePermissionsContext({
    account: wallet.address,
    signer,
    expiry,
    permissionsHash,
  });

  const grantSignature = accountWallet.signMessageSync(
    getBytes(grantDigest),
  ) as Hex;

  const recovered = verifyMessage(getBytes(grantDigest), grantSignature);
  if (recovered !== wallet.address) {
    throw new Error("Grant signature does not recover to the account address");
  }

  const row = insertPermissionSession({
    walletId: wallet.id,
    account: wallet.address,
    signerType,
    signerId: sessionWallet.address,
    sessionSeed,
    expiry,
    grantedAt,
    permissions: canonicalJson(permissions),
    permissionsHash,
    permissionsContext,
    grantDigest,
    grantSignature,
  });

  // `factory`/`factoryData`/`signerData` are only meaningful for smart accounts
  // (counterfactual deployment, ERC-4337 submission). These are HD-derived EOAs,
  // so they are omitted rather than emitted empty.
  const response: GrantPermissionsResponse = {
    expiry,
    grantedPermissions: permissions.map((permission) => ({
      type: permission.type,
      data: permission.data as Record<string, unknown>,
      policies: permission.policies,
    })),
    permissionsContext,
  };

  return { request, response, session: toSessionView(row) };
}

export function getSession(sessionId: number): PermissionSessionView {
  const row = getPermissionSessionById(sessionId);
  if (!row) {
    throw new Error(`Permission session ${sessionId} does not exist`);
  }
  return toSessionView(row);
}

export function listSessions(walletIndex?: number): PermissionSessionView[] {
  if (walletIndex === undefined) {
    return getPermissionSessions().map(toSessionView);
  }

  const wallet = getWalletByIndex(walletIndex);
  if (!wallet) {
    throw new Error(`Wallet index ${walletIndex} does not exist`);
  }

  return getPermissionSessions(wallet.id).map(toSessionView);
}

export function revokeSession(sessionId: number): PermissionSessionView {
  const row = getPermissionSessionById(sessionId);
  if (!row) {
    throw new Error(`Permission session ${sessionId} does not exist`);
  }

  revokePermissionSession(row.id, nowSeconds());
  return getSession(sessionId);
}

/**
 * Contexts are self-describing: decode one and check it against the store
 * without trusting the caller's `sessionId`.
 */
export function inspectContext(context: string) {
  const decoded = decodePermissionsContext(context as Hex);
  const row = getPermissionSessionByContext(context);

  return {
    ...decoded,
    known: row !== undefined,
    sessionId: row?.id ?? null,
    intact: row?.permissions_hash === decoded.permissionsHash,
  };
}

/** Strictest `spending-cap` across every granted permission, if any. */
export function spendingCapOf(permissions: Permission[]): bigint | null {
  const limits = permissions
    .flatMap((permission) => permission.policies ?? [])
    .filter((policy) => policy.type === ENFORCED_POLICY_TYPES.spendingCap)
    .map((policy) => BigInt(String(policy.data?.limit ?? "0")));

  if (limits.length === 0) {
    return null;
  }

  return limits.reduce((min, limit) => (limit < min ? limit : min));
}

/** Strictest `value-limit` across every granted permission, if any. */
export function valueLimitOf(permissions: Permission[]): bigint | null {
  const limits = permissions
    .flatMap((permission) => permission.policies ?? [])
    .filter((policy) => policy.type === ENFORCED_POLICY_TYPES.valueLimit)
    .map((policy) => BigInt(String(policy.data?.limit ?? "0")));

  if (limits.length === 0) {
    return null;
  }

  return limits.reduce((min, limit) => (limit < min ? limit : min));
}

export async function redeemPermission(
  input: RedeemInput,
): Promise<RedeemResult> {
  const row = getPermissionSessionById(input.sessionId);
  if (!row) {
    throw new Error(`Permission session ${input.sessionId} does not exist`);
  }

  assertSessionUsable(row);

  const wallet = getWalletById(row.wallet_id);
  if (!wallet) {
    throw new Error(`Wallet for permission session ${row.id} does not exist`);
  }

  const permissions = parsePermissions(row);
  const to = normalizeDestinationAddress(input.toAddress);
  const value = parseAmountWei(input.amountWei);

  if (
    !permissions.some(
      (permission) => permission.type === EXECUTABLE_PERMISSION_TYPE,
    )
  ) {
    throw new Error(
      `Permission session ${row.id} does not grant '${EXECUTABLE_PERMISSION_TYPE}'; this backend can only redeem native ETH transfers`,
    );
  }

  const valueLimit = valueLimitOf(permissions);
  if (valueLimit !== null && value > valueLimit) {
    throw new Error(
      `Amount ${value} wei exceeds the per-action value-limit of ${valueLimit} wei`,
    );
  }

  const cap = spendingCapOf(permissions);
  const spent = BigInt(row.spent_wei);

  // Read-only check so a build-only redemption still reports a breach up front.
  if (cap !== null && spent + value > cap) {
    throw new Error(
      `Amount ${value} wei exceeds the remaining spending cap of ${cap - spent} wei`,
    );
  }

  // Broadcasts then reserve spend and claim the action nonce atomically, before
  // any funds move, so two concurrent redemptions cannot both read the same
  // spent_wei and both pass the check above. Build-only redemptions move
  // nothing, so they consume neither the cap nor the nonce.
  const reservation = input.broadcast
    ? reserveSessionSpend({
        id: row.id,
        amountWei: value.toString(),
        cap,
        now: nowSeconds(),
      })
    : null;

  if (reservation && !reservation.ok) {
    throw new Error(reservation.reason!);
  }

  const actionNonce = reservation ? reservation.nonce : row.nonce;

  const accountWallet = deriveWalletAtIndex(config.walletMnemonic, wallet.index);
  const sessionWallet = deriveSessionWallet(accountWallet.privateKey, row.session_seed);

  if (sessionWallet.address !== row.signer_id) {
    throw new Error(
      `Re-derived session key does not match the granted signer for session ${row.id}`,
    );
  }

  const signer: SignerSpec = {
    type: row.signer_type as SignerType,
    data: { id: row.signer_id as Hex },
  };

  const decoded = decodePermissionsContext(row.permissions_context as Hex);
  if (
    decoded.permissionsHash !== row.permissions_hash ||
    decoded.signerHash !== hashSigner(signer) ||
    decoded.account !== wallet.address
  ) {
    throw new Error(
      `Stored permissionsContext for session ${row.id} does not match the grant`,
    );
  }

  const actionDigest = buildActionDigest({
    permissionsContext: row.permissions_context as Hex,
    to,
    value,
    data: NATIVE_TRANSFER_CALLDATA,
    nonce: actionNonce,
  });

  const sessionKeySignature = (await sessionWallet.signMessage(
    getBytes(actionDigest),
  )) as Hex;

  const recoveredSigner = verifyMessage(
    getBytes(actionDigest),
    sessionKeySignature,
  );

  if (recoveredSigner !== row.signer_id) {
    throw new Error(
      `Session key signature recovers to ${recoveredSigner}, expected ${row.signer_id}`,
    );
  }

  try {
    const withdrawal = await createWithdrawal({
      fromWalletIndex: wallet.index,
      toAddress: to,
      amountWei: value.toString(),
      broadcast: input.broadcast,
      actor: input.actor ?? null,
    });

    return {
      session: getSession(row.id),
      authorization: {
        actionDigest,
        nonce: actionNonce,
        sessionKeySignature,
        recoveredSigner,
      },
      withdrawal,
    };
  } catch (error) {
    // Nothing moved, so give the reservation back.
    if (reservation) {
      releaseSessionSpend(row.id, value.toString());
    }
    throw error;
  }
}

function assertSessionUsable(row: PermissionSessionRow): void {
  if (row.revoked_at !== null) {
    throw new Error(
      `Permission session ${row.id} was revoked at ${new Date(row.revoked_at * 1000).toISOString()}`,
    );
  }

  if (nowSeconds() >= row.expiry) {
    throw new Error(
      `Permission session ${row.id} expired at ${new Date(row.expiry * 1000).toISOString()}`,
    );
  }
}

function parsePermissions(row: PermissionSessionRow): Permission[] {
  return JSON.parse(row.permissions) as Permission[];
}

export function toSessionView(row: PermissionSessionRow): PermissionSessionView {
  const now = nowSeconds();
  const permissions = parsePermissions(row);
  const cap = spendingCapOf(permissions);
  const spent = BigInt(row.spent_wei);

  const status: PermissionSessionView["status"] =
    row.revoked_at !== null ? "revoked" : now >= row.expiry ? "expired" : "active";

  return {
    id: row.id,
    walletIndex: getWalletById(row.wallet_id)?.index ?? -1,
    account: row.account,
    status,
    signer: { type: row.signer_type as SignerType, id: row.signer_id },
    expiry: row.expiry,
    expiresAt: new Date(row.expiry * 1000).toISOString(),
    grantedAt: new Date(row.granted_at * 1000).toISOString(),
    remainingSeconds: Math.max(0, row.expiry - now),
    permissions,
    permissionsHash: row.permissions_hash,
    permissionsContext: row.permissions_context,
    grantDigest: row.grant_digest,
    grantSignature: row.grant_signature,
    spentWei: row.spent_wei,
    remainingWei: cap === null ? null : (cap - spent).toString(),
    nonce: row.nonce,
    revokedAt:
      row.revoked_at === null ? null : new Date(row.revoked_at * 1000).toISOString(),
  };
}
