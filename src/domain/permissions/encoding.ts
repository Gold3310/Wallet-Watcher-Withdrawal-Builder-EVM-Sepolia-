/**
 * Deterministic encoding of ERC-7715 permissions.
 *
 * A granted permission has to be reducible to a single bytes32 that both sides
 * can recompute (the wallet when granting, this backend when redeeming), so
 * every element is hashed with a fixed, documented layout:
 *
 *   selector(signature)      = 4-byte selector, or id(signature)[0:4]
 *   dataHash                 = keccak256(abi.encode(address, keccak256(selectors)))
 *   policiesHash             = keccak256(concat(policyHash...))   | 0x00..00 when empty
 *   permissionHash           = keccak256(abi.encode(PERMISSION_TYPEHASH,
 *                                  keccak256(type), dataHash, policiesHash))
 *   permissionsHash          = keccak256(concat(permissionHash...))
 *   grantDigest              = keccak256(abi.encode(GRANT_TYPEHASH, account,
 *                                  signerHash, expiry, permissionsHash))
 *   permissionsContext       = 0x77150001 ++ abi.encode(account, signerHash,
 *                                  expiry, permissionsHash)
 *
 * `0x77150001` is a 4-byte tag: the ERC number (7715) and encoding version (1).
 * It lets a verifier tell this context apart from any other opaque blob.
 */
import {
  AbiCoder,
  concat,
  getAddress,
  getBytes,
  id,
  isHexString,
  keccak256,
  toUtf8Bytes,
  ZeroAddress,
  ZeroHash,
} from "ethers";
import { canonicalJson } from "../../util/canonical.js";
import type {
  Hex,
  Permission,
  PermissionData,
  Policy,
  SignerSpec,
} from "./types.js";

const abi = AbiCoder.defaultAbiCoder();

/** ERC number + encoding version, prefixed onto every permissionsContext. */
export const CONTEXT_TAG = "0x77150001";

export const PERMISSION_TYPEHASH = keccak256(
  toUtf8Bytes("Permission(string type,bytes data,bytes32 policiesHash)"),
);

export const GRANT_TYPEHASH = keccak256(
  toUtf8Bytes(
    "GrantPermissions(address account,bytes32 signerHash,uint256 expiry,bytes32 permissionsHash)",
  ),
);

export const ACTION_TYPEHASH = keccak256(
  toUtf8Bytes(
    "SessionAction(bytes32 permissionsContextHash,address to,uint256 value,bytes32 dataHash,uint256 nonce)",
  ),
);

/** Accepts either a 4-byte selector (`0x12345678`) or a full signature. */
export function selectorOf(signature?: string): Hex {
  if (!signature) {
    throw new Error("Each allowed call needs a signature or 4-byte selector");
  }

  const trimmed = signature.trim();

  if (/^0x[0-9a-fA-F]{8}$/.test(trimmed)) {
    return trimmed.toLowerCase() as Hex;
  }

  return id(trimmed).slice(0, 10) as Hex;
}

export function hashPermissionData(data: PermissionData): Hex {
  const address = data.address ? getAddress(data.address) : ZeroAddress;
  const selectors = (data.calls ?? []).map((call) => selectorOf(call.signature));

  return keccak256(
    abi.encode(["address", "bytes32"], [address, keccak256(concat(selectors))]),
  ) as Hex;
}

export function hashPolicy(policy: Policy): Hex {
  return keccak256(
    abi.encode(
      ["bytes32", "bytes32"],
      [
        keccak256(toUtf8Bytes(policy.type)),
        keccak256(toUtf8Bytes(canonicalJson(policy.data ?? {}))),
      ],
    ),
  ) as Hex;
}

export function hashPolicies(policies: Policy[]): Hex {
  if (policies.length === 0) {
    return ZeroHash as Hex;
  }

  return keccak256(concat(policies.map(hashPolicy))) as Hex;
}

export function hashPermission(permission: Permission): Hex {
  return keccak256(
    abi.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32"],
      [
        PERMISSION_TYPEHASH,
        keccak256(toUtf8Bytes(permission.type)),
        hashPermissionData(permission.data),
        hashPolicies(permission.policies ?? []),
      ],
    ),
  ) as Hex;
}

export function hashPermissions(permissions: Permission[]): Hex {
  return keccak256(concat(permissions.map(hashPermission))) as Hex;
}

/**
 * The signer id is an address for `type: 'account'` and a public key for
 * `type: 'key'`, so it is hashed as opaque bytes rather than cast to an address.
 */
export function hashSigner(signer: SignerSpec): Hex {
  if (!isHexString(signer.data?.id)) {
    throw new Error("signer.data.id must be a hex string");
  }

  return keccak256(
    concat([toUtf8Bytes(signer.type), getBytes(signer.data.id)]),
  ) as Hex;
}

export function buildGrantDigest(params: {
  account: string;
  signer: SignerSpec;
  expiry: number;
  permissionsHash: Hex;
}): Hex {
  return keccak256(
    abi.encode(
      ["bytes32", "address", "bytes32", "uint256", "bytes32"],
      [
        GRANT_TYPEHASH,
        getAddress(params.account),
        hashSigner(params.signer),
        params.expiry,
        params.permissionsHash,
      ],
    ),
  ) as Hex;
}

export function encodePermissionsContext(params: {
  account: string;
  signer: SignerSpec;
  expiry: number;
  permissionsHash: Hex;
}): Hex {
  return concat([
    CONTEXT_TAG,
    abi.encode(
      ["address", "bytes32", "uint256", "bytes32"],
      [
        getAddress(params.account),
        hashSigner(params.signer),
        params.expiry,
        params.permissionsHash,
      ],
    ),
  ]) as Hex;
}

export function decodePermissionsContext(context: Hex): {
  tag: string;
  account: string;
  signerHash: Hex;
  expiry: number;
  permissionsHash: Hex;
} {
  const bytes = getBytes(context);
  if (bytes.length < 4) {
    throw new Error("permissionsContext is too short");
  }

  const decoded = abi.decode(
    ["address", "bytes32", "uint256", "bytes32"],
    bytes.subarray(4),
  );

  return {
    tag: context.slice(0, 10),
    account: getAddress(decoded[0] as string),
    signerHash: decoded[1] as Hex,
    expiry: Number(decoded[2]),
    permissionsHash: decoded[3] as Hex,
  };
}

/** Digest the session key signs to authorise one concrete action. */
export function buildActionDigest(params: {
  permissionsContext: Hex;
  to: string;
  value: bigint;
  data: Hex;
  nonce: number;
}): Hex {
  return keccak256(
    abi.encode(
      ["bytes32", "bytes32", "address", "uint256", "bytes32", "uint256"],
      [
        ACTION_TYPEHASH,
        keccak256(getBytes(params.permissionsContext)),
        getAddress(params.to),
        params.value,
        keccak256(getBytes(params.data)),
        params.nonce,
      ],
    ),
  ) as Hex;
}
