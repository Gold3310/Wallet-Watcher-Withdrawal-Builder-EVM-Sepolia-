/**
 * Recovering a function signature from what a decoder printed.
 *
 * Decoders usually show a function *name* and its arguments, not the canonical
 * signature — "addObserver" with `[address, 0]`, not
 * "addObserver(address,uint8)". The name alone proves nothing: the selector is
 * the hash of the full signature, so a label is only confirmed once some
 * signature with that name hashes to the selector actually in the bytes.
 *
 * So the search is: list the Solidity types each printed argument could have
 * been, try every combination under the claimed name, and keep the one whose
 * keccak256 starts with the selector. A 4-byte match on its own is strong but
 * not proof; the verifier then decodes the calldata with the recovered
 * signature and requires a byte-identical re-encoding, which an accidental
 * match would not survive.
 *
 * Anything the search cannot express (tuples, structs) needs an explicit
 * signature instead.
 */
import { FunctionFragment, ZeroHash, id } from "ethers";

const INT_SIZES = Array.from({ length: 32 }, (_, index) => (index + 1) * 8);

/** Element types tried for an empty array, where no element shows its type. */
const EMPTY_ARRAY_ELEMENT_TYPES = ["address", "uint256", "bytes32", "bytes", "string", "bool", "uint8"];

/** Default ceiling on signatures hashed for one call. */
export const DEFAULT_SIGNATURE_SEARCH_LIMIT = 250_000;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function numericTypes(value: bigint): string[] {
  const types: string[] = [];

  for (const bits of INT_SIZES) {
    if (value >= 0n && value < 1n << BigInt(bits)) {
      types.push(`uint${bits}`);
    }
  }

  for (const bits of INT_SIZES) {
    const half = 1n << BigInt(bits - 1);
    if (value >= -half && value < half) {
      types.push(`int${bits}`);
    }
  }

  if (value === 0n || value === 1n) {
    types.push("bool");
  }

  return types;
}

function intersect(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  if (!first) {
    return [];
  }
  return first.filter((type) => rest.every((list) => list.includes(type)));
}

/**
 * The Solidity types a printed argument could have been encoded as.
 *
 * Returns an empty list when nothing can be inferred — objects (tuples), null,
 * and JSON numbers past 2^53 whose exact value was already lost in parsing.
 */
export function candidateTypes(value: unknown): string[] {
  if (typeof value === "boolean") {
    return ["bool"];
  }

  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? numericTypes(BigInt(value)) : [];
  }

  if (typeof value === "bigint") {
    return numericTypes(value);
  }

  if (typeof value === "string") {
    if (/^-?\d+$/.test(value)) {
      return [...numericTypes(BigInt(value)), "string"];
    }

    if (/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
      const length = (value.length - 2) / 2;
      const types: string[] = [];
      if (length === 20) {
        types.push("address");
      }
      if (length >= 1 && length <= 32) {
        types.push(`bytes${length}`);
      }
      if (length === 32) {
        types.push("uint256");
      }
      types.push("bytes", "string");
      return types;
    }

    return ["string"];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return EMPTY_ARRAY_ELEMENT_TYPES.map((type) => `${type}[]`);
    }
    const element = intersect(value.map(candidateTypes));
    return element.flatMap((type) => [`${type}[]`, `${type}[${value.length}]`]);
  }

  return [];
}

/** True for a JSON number too large to have survived parsing exactly. */
export function isLossyNumber(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value) && !Number.isSafeInteger(value);
  }
  if (Array.isArray(value)) {
    return value.some(isLossyNumber);
  }
  return false;
}

export interface SignatureSearch {
  /** The one signature whose selector matched, or null. */
  signature: string | null;
  /** How many candidate signatures were hashed. */
  tried: number;
  /** Set when the candidate space exceeded the limit and was not searched. */
  tooLarge: boolean;
  /** Set when more than one candidate matched (a selector collision). */
  ambiguous?: string[];
}

/**
 * Finds the signature named `name`, consistent with the printed `args`, whose
 * selector is `selector`. Returns `signature: null` when there is none.
 */
export function inferSignature(
  name: string,
  args: readonly unknown[],
  selector: string,
  limit = DEFAULT_SIGNATURE_SEARCH_LIMIT,
): SignatureSearch {
  const none: SignatureSearch = { signature: null, tried: 0, tooLarge: false };

  if (!IDENTIFIER.test(name)) {
    return none;
  }

  const perArgument = args.map(candidateTypes);
  if (perArgument.some((types) => types.length === 0)) {
    return none;
  }

  const total = perArgument.reduce((product, types) => product * types.length, 1);
  if (total > limit) {
    return { ...none, tooLarge: true };
  }

  const target = selector.toLowerCase();
  const matches: string[] = [];
  let tried = 0;

  const walk = (position: number, chosen: string[]): void => {
    if (position === perArgument.length) {
      tried += 1;
      const signature = `${name}(${chosen.join(",")})`;
      if (id(signature).slice(0, 10) === target) {
        matches.push(signature);
      }
      return;
    }
    for (const type of perArgument[position]!) {
      walk(position + 1, [...chosen, type]);
    }
  };

  walk(0, []);

  if (matches.length > 1) {
    return { signature: null, tried, tooLarge: false, ambiguous: matches };
  }

  return { signature: matches[0] ?? null, tried, tooLarge: false };
}

/** Parses "name(type,…)" into a fragment, or throws with the offending text. */
export function parseSignature(signature: string): FunctionFragment {
  try {
    return FunctionFragment.from(signature.trim());
  } catch {
    throw new Error(`Not a function signature: "${signature}". Expected e.g. "grantRole(bytes32,address)".`);
  }
}

/**
 * Role names recognised in bytes32 arguments. Each is matched by its keccak256,
 * so a label is only applied when the hash is exact.
 */
export const KNOWN_ROLE_NAMES: readonly string[] = [
  // Easy Track AllowedRecipientsRegistry / LimitsChecker
  "ADD_RECIPIENT_TO_ALLOWED_LIST_ROLE",
  "REMOVE_RECIPIENT_FROM_ALLOWED_LIST_ROLE",
  "SET_PARAMETERS_ROLE",
  "UPDATE_SPENT_AMOUNT_ROLE",
  "ADD_TOKEN_TO_ALLOWED_LIST_ROLE",
  "REMOVE_TOKEN_FROM_ALLOWED_LIST_ROLE",
  // aragonOS Kernel, ACL, Agent, Vault, Voting, Finance
  "APP_MANAGER_ROLE",
  "CREATE_PERMISSIONS_ROLE",
  "EXECUTE_ROLE",
  "SAFE_EXECUTE_ROLE",
  "RUN_SCRIPT_ROLE",
  "TRANSFER_ROLE",
  "ADD_PROTECTED_TOKEN_ROLE",
  "REMOVE_PROTECTED_TOKEN_ROLE",
  "ADD_PRESIGNED_HASH_ROLE",
  "DESIGNATE_SIGNER_ROLE",
  "CREATE_VOTES_ROLE",
  "MODIFY_QUORUM_ROLE",
  "MODIFY_SUPPORT_ROLE",
  "CREATE_PAYMENTS_ROLE",
  // Common OpenZeppelin AccessControl names
  "MANAGER_ROLE",
  "EMERGENCY_ROLE",
  "PAUSE_ROLE",
  "RESUME_ROLE",
  "PAUSER_ROLE",
  "MINTER_ROLE",
  "BURNER_ROLE",
  "UPGRADER_ROLE",
  "OPERATOR_ROLE",
];

/** Map from lowercase role hash to a readable label. */
export function roleTable(extraNames: readonly string[] = []): Map<string, string> {
  const table = new Map<string, string>();
  table.set(ZeroHash, "DEFAULT_ADMIN_ROLE (OpenZeppelin AccessControl, 0x00)");
  for (const name of [...KNOWN_ROLE_NAMES, ...extraNames]) {
    table.set(id(name).toLowerCase(), `keccak256("${name}")`);
  }
  return table;
}
