/**
 * Checking a decoder's view of an Aragon EVMScript against the bytes.
 *
 * A decoded payload — contract names, function names, arguments, nested calls —
 * is a claim about bytes, and only the bytes execute. This module re-derives
 * everything it can from the bytes and compares:
 *
 *   - nested calls are re-parsed from the raw script in the parent's arguments,
 *     never taken from the decoder's own list, so a call the view hides,
 *     invents or reorders shows up as a mismatch
 *   - each call's target and selector are compared with the script
 *   - the function name is only accepted once a signature with that name
 *     hashes to the selector in the bytes
 *   - arguments are decoded from the calldata and compared with the claim,
 *     and the calldata must re-encode byte for byte, so dirty padding or
 *     trailing data cannot hide behind a tidy decoded view
 *
 * Offline and read-only: no provider, no signing. Top-level calls carry no raw
 * calldata in a decoded payload, so their arguments are the input everything
 * nested is checked against.
 */
import fs from "node:fs";
import { AbiCoder, FunctionFragment, ParamType, dataSlice, getAddress } from "ethers";
import { ScriptCall, tryParseEvmScript } from "./evmscript.js";
import { inferSignature, isLossyNumber, parseSignature, roleTable } from "./signatures.js";

export interface DecodedCall {
  contractAddress: string;
  /** The decoder's own numbering. Informational: position is what executes. */
  id?: number;
  /** A label from the decoder. Nothing in the bytes confirms it. */
  contractName?: string;
  functionName: string;
  selector: string;
  args: unknown[];
  nestedCalls: DecodedCall[];
}

export type CallStatus = "VERIFIED" | "MISMATCH" | "UNRESOLVED";

export type SignatureSource = "explicit" | "stated" | "inferred";

export interface CallVerification {
  /** Position in the tree, 1-based: "1", "1.3", "1.3.2". Not the decoder's id. */
  path: string;
  status: CallStatus;
  /** The target from the raw bytes; for a top-level call, the claimed address. */
  to: string | null;
  /** The decoder's label, as claimed and unverified. */
  contractName: string | null;
  functionName: string;
  /** The selector from the raw bytes; for a top-level call, the claimed one. */
  selector: string | null;
  signature: string | null;
  signatureSource: SignatureSource | null;
  checks: Record<string, boolean>;
  notes: string[];
  /** Readings that need no trust, e.g. a bytes32 that is the hash of a role name. */
  annotations: string[];
}

export interface DecodedVerificationReport {
  verifiedAt: string;
  fullyVerified: boolean;
  summary: Record<CallStatus, number>;
  /** Depth-first: each call is followed by the calls nested inside it. */
  calls: CallVerification[];
  notes: string[];
  notChecked: string[];
}

export interface VerifyDecodedOptions {
  /** Signatures to use instead of inference, e.g. "addObserver(address,uint8)". */
  signatures?: readonly string[];
  /** Extra role names to recognise in bytes32 arguments. */
  roleNames?: readonly string[];
}

/** What verification cannot establish. Carried in every report. */
export const NOT_CHECKED: readonly string[] = [
  "Which chain this is for. The payload carries no chain id, and the same address can be a different contract, or nothing, on another chain.",
  "The contractName labels. They come from the decoder; nothing in the bytes confirms them.",
  "Whether the vote or proposal carrying this script passed, is pending, or was executed.",
  "That these are the bytes submitted on chain. Compare the top-level arguments with the script stored in the vote or transaction.",
  "Who may execute it. Aragon's Agent.forward() requires RUN_SCRIPT_ROLE and reverts with AGENT_CAN_NOT_FORWARD for any other sender.",
  "What upgraded or newly referenced code does once the calls run.",
];

const coder = AbiCoder.defaultAbiCoder();
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCall(value: unknown, path: string): DecodedCall {
  if (!isRecord(value)) {
    throw new Error(`Call ${path}: expected an object.`);
  }

  const { contractAddress, functionName, selector, args, nestedCalls, id, contractName } = value;

  if (typeof contractAddress !== "string") {
    throw new Error(`Call ${path}: contractAddress must be a string.`);
  }
  if (typeof functionName !== "string" || functionName.length === 0) {
    throw new Error(`Call ${path}: functionName must be a non-empty string.`);
  }
  if (typeof selector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(selector)) {
    throw new Error(`Call ${path}: selector must be 4 bytes of 0x-prefixed hex.`);
  }
  if (!Array.isArray(args)) {
    throw new Error(`Call ${path}: args must be an array.`);
  }
  if (nestedCalls !== undefined && !Array.isArray(nestedCalls)) {
    throw new Error(`Call ${path}: nestedCalls must be an array when present.`);
  }

  return {
    contractAddress,
    functionName,
    selector,
    args,
    id: typeof id === "number" ? id : undefined,
    contractName: typeof contractName === "string" ? contractName : undefined,
    nestedCalls: (nestedCalls ?? []).map((child, index) => validateCall(child, `${path}.${index + 1}`)),
  };
}

/** Accepts one decoded call or an array of them. */
export function parseDecodedCalls(input: unknown): DecodedCall[] {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) {
    throw new Error("No calls found: expected a decoded call or an array of them.");
  }
  return list.map((item, index) => validateCall(item, `${index + 1}`));
}

export function loadDecodedCalls(path: string): DecodedCall[] {
  return parseDecodedCalls(JSON.parse(fs.readFileSync(path, "utf8")));
}

// ---------------------------------------------------------------------------
// Comparing values
// ---------------------------------------------------------------------------

function safeAddress(value: unknown): string | null {
  if (typeof value !== "string" || !ADDRESS_SHAPE.test(value)) {
    return null;
  }
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

/** Mixed-case addresses carry an EIP-55 checksum; a wrong one usually means a typo or an edit. */
function badChecksums(value: unknown, label: string, out: string[]): void {
  if (typeof value === "string" && ADDRESS_SHAPE.test(value) && safeAddress(value) === null) {
    out.push(`${label} (${value}) has an invalid EIP-55 checksum.`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => badChecksums(item, `${label}[${index}]`, out));
  }
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value === "string") {
    if (/^-?\d+$/.test(value)) {
      return BigInt(value);
    }
    const hex = /^(-?)(0x[0-9a-fA-F]+)$/.exec(value);
    if (hex) {
      const magnitude = BigInt(hex[2]!);
      return hex[1] ? -magnitude : magnitude;
    }
  }
  return null;
}

function toBool(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 0 || value === 1) {
    return value === 1;
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  return null;
}

function sameValue(param: ParamType, claimed: unknown, decoded: unknown): boolean {
  if (param.isArray()) {
    if (!Array.isArray(claimed) || !Array.isArray(decoded) || claimed.length !== decoded.length) {
      return false;
    }
    const child = param.arrayChildren;
    return claimed.every((item, index) => sameValue(child, item, decoded[index]));
  }

  if (param.isTuple()) {
    const components = param.components;
    const values = Array.isArray(claimed)
      ? claimed
      : isRecord(claimed)
        ? components.map((component) => claimed[component.name])
        : null;
    if (!values || !Array.isArray(decoded) || values.length !== components.length) {
      return false;
    }
    return components.every((component, index) => sameValue(component, values[index], decoded[index]));
  }

  const type = param.baseType;

  if (type === "address") {
    const address = safeAddress(claimed);
    return address !== null && address === decoded;
  }
  if (type === "bool") {
    return toBool(claimed) === decoded;
  }
  if (type === "string") {
    return claimed === decoded;
  }
  if (type.startsWith("bytes")) {
    return (
      typeof claimed === "string" &&
      typeof decoded === "string" &&
      claimed.toLowerCase() === decoded.toLowerCase()
    );
  }
  if (/^u?int\d*$/.test(type)) {
    const number = toBigInt(claimed);
    return number !== null && number === decoded;
  }

  return false;
}

function display(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function annotateRoles(
  param: ParamType,
  value: unknown,
  label: string,
  roles: Map<string, string>,
  out: string[],
): void {
  if (param.isArray()) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => annotateRoles(param.arrayChildren, item, `${label}[${index}]`, roles, out));
    }
    return;
  }

  if (param.isTuple()) {
    if (Array.isArray(value)) {
      param.components.forEach((component, index) =>
        annotateRoles(component, value[index], `${label}.${component.name || index}`, roles, out),
      );
    }
    return;
  }

  if (param.baseType === "bytes32" && typeof value === "string") {
    const role = roles.get(value.toLowerCase());
    if (role) {
      out.push(`${label} is ${role}`);
    }
  }
}

function errorText(error: unknown): string {
  const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
  if (typeof short === "string" && short.length > 0) {
    return short;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface Context {
  explicit: Map<string, FunctionFragment>;
  roles: Map<string, string>;
  out: CallVerification[];
  scriptsParsed: number;
}

interface Resolution {
  fragment: FunctionFragment | null;
  source: SignatureSource | null;
  /** The decoder stated or was given a signature the name contradicts. */
  contradicted: boolean;
}

function bareName(functionName: string): string {
  const paren = functionName.indexOf("(");
  return paren === -1 ? functionName : functionName.slice(0, paren);
}

function resolveSignature(
  claim: DecodedCall,
  selector: string,
  ctx: Context,
  notes: string[],
): Resolution {
  const explicit = ctx.explicit.get(selector);
  if (explicit) {
    return { fragment: explicit, source: "explicit", contradicted: false };
  }

  if (claim.functionName.includes("(")) {
    let stated: FunctionFragment;
    try {
      stated = FunctionFragment.from(claim.functionName);
    } catch {
      notes.push(`functionName "${claim.functionName}" is not a parseable signature.`);
      return { fragment: null, source: null, contradicted: true };
    }
    if (stated.selector === selector) {
      return { fragment: stated, source: "stated", contradicted: false };
    }
    notes.push(
      `functionName states ${stated.format("sighash")}, which hashes to ${stated.selector}, not ${selector}.`,
    );
    return { fragment: null, source: null, contradicted: true };
  }

  const search = inferSignature(claim.functionName, claim.args, selector);
  if (search.signature) {
    return { fragment: FunctionFragment.from(search.signature), source: "inferred", contradicted: false };
  }

  if (search.ambiguous) {
    notes.push(
      `Several signatures named ${claim.functionName} hash to ${selector}: ` +
        `${search.ambiguous.join(", ")}. Pass the right one with --sig.`,
    );
  } else if (search.tooLarge) {
    notes.push(`Too many candidate signatures to search for ${claim.functionName}; pass it with --sig.`);
  } else if (claim.args.some(isLossyNumber)) {
    notes.push(
      "An argument is a JSON number beyond 2^53, so its exact value was lost when the file was parsed. " +
        "Have the decoder print large integers as strings.",
    );
  } else {
    notes.push(
      `No signature named ${claim.functionName} with arguments shaped like these hashes to ${selector} ` +
        `(${search.tried} tried). The label may be wrong, or an argument is a tuple: pass the ` +
        "signature with --sig.",
    );
  }

  return { fragment: null, source: null, contradicted: false };
}

/** `bytes` arguments that parse as a CallsScript, with their calls. */
function scriptArguments(
  fragment: FunctionFragment | null,
  values: readonly unknown[],
): { index: number; calls: ScriptCall[] }[] {
  const found: { index: number; calls: ScriptCall[] }[] = [];

  values.forEach((value, index) => {
    const param = fragment?.inputs[index];
    if ((param && param.baseType !== "bytes") || typeof value !== "string") {
      return;
    }
    const calls = tryParseEvmScript(value);
    if (calls) {
      found.push({ index, calls });
    }
  });

  return found;
}

function missingFromView(raw: ScriptCall, path: string): CallVerification {
  return {
    path,
    status: "MISMATCH",
    to: raw.to,
    contractName: null,
    functionName: "",
    selector: raw.selector,
    signature: null,
    signatureSource: null,
    checks: { listedInDecodedView: false },
    notes: [
      `Present in the raw script but missing from the decoded view: a call to ${raw.to} ` +
        `with selector ${raw.selector ?? "(none)"}.`,
    ],
    annotations: [],
  };
}

function unverifiedChild(claim: DecodedCall, path: string, reason: string, status: CallStatus): CallVerification {
  return {
    path,
    status,
    to: safeAddress(claim.contractAddress),
    contractName: claim.contractName ?? null,
    functionName: claim.functionName,
    selector: claim.selector.toLowerCase(),
    signature: null,
    signatureSource: null,
    checks: status === "MISMATCH" ? { presentInBytes: false } : {},
    notes: [reason],
    annotations: [],
  };
}

function checkCall(
  claim: DecodedCall,
  raw: ScriptCall | null,
  path: string,
  position: number,
  ctx: Context,
): void {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];
  const annotations: string[] = [];

  const claimedSelector = claim.selector.toLowerCase();
  const claimedTo = safeAddress(claim.contractAddress);

  const addressNotes: string[] = [];
  badChecksums(claim.contractAddress, "contractAddress", addressNotes);
  if (claimedTo === null && addressNotes.length === 0) {
    addressNotes.push(`contractAddress ${claim.contractAddress} is not a valid address.`);
  }
  notes.push(...addressNotes);
  claim.args.forEach((arg, index) => badChecksums(arg, `args[${index}]`, notes));

  if (claim.id !== undefined && claim.id !== position) {
    notes.push(`Decoder id ${claim.id} differs from position ${position}; position is what executes.`);
  }

  // Target and selector: against the bytes when there are bytes.
  if (raw) {
    checks.target = claimedTo !== null && claimedTo === raw.to;
    if (!checks.target) {
      notes.push(`Claimed target ${claim.contractAddress}, but the script calls ${raw.to}.`);
    }
    checks.selector = raw.selector !== null && claimedSelector === raw.selector;
    if (raw.selector === null) {
      notes.push(`The call carries ${(raw.calldata.length - 2) / 2} byte(s) of calldata, too short for a selector.`);
    } else if (!checks.selector) {
      notes.push(`Claimed selector ${claimedSelector}, but the calldata starts with ${raw.selector}.`);
    }
  } else {
    checks.contractAddress = claimedTo !== null;
  }

  const actualSelector = raw ? raw.selector : claimedSelector;
  const resolution: Resolution = actualSelector
    ? resolveSignature(claim, actualSelector, ctx, notes)
    : { fragment: null, source: null, contradicted: false };
  const { fragment } = resolution;

  if (resolution.contradicted) {
    checks.functionName = false;
  }

  // Values the nested script, if any, is read from. Null when they cannot be
  // taken from the bytes.
  let values: readonly unknown[] | null = null;

  if (fragment) {
    const signature = fragment.format("sighash");

    checks.functionName = fragment.name === bareName(claim.functionName);
    if (!checks.functionName) {
      notes.push(`functionName "${claim.functionName}", but the signature is ${signature}.`);
    }

    checks.argumentCount = claim.args.length === fragment.inputs.length;
    if (!checks.argumentCount) {
      notes.push(`${claim.args.length} argument(s) claimed; ${signature} takes ${fragment.inputs.length}.`);
    }

    if (raw) {
      const encoded = dataSlice(raw.calldata, 4);
      try {
        const decoded = coder.decode(fragment.inputs, encoded);
        values = Array.from(decoded);
        checks.decodes = true;

        const mismatched = fragment.inputs
          .map((param, index) => ({ param, index }))
          .filter(({ param, index }) => !sameValue(param, claim.args[index], decoded[index]));
        checks.arguments = checks.argumentCount && mismatched.length === 0;
        for (const { index } of mismatched) {
          notes.push(`args[${index}]: claimed ${display(claim.args[index])}, encoded ${display(decoded[index])}.`);
        }

        const reencoded = coder.encode(fragment.inputs, decoded);
        checks.canonicalEncoding = reencoded.toLowerCase() === encoded.toLowerCase();
        if (!checks.canonicalEncoding) {
          notes.push(
            `Calldata is not canonically encoded: it carries bytes the decoded arguments do not show ` +
              `(${(encoded.length - 2) / 2} argument bytes; a clean encoding is ${(reencoded.length - 2) / 2}).`,
          );
        }
      } catch (error) {
        checks.decodes = false;
        notes.push(`Calldata does not decode as ${signature}: ${errorText(error)}`);
      }
    } else {
      try {
        values = Array.from(coder.decode(fragment.inputs, coder.encode(fragment.inputs, claim.args)));
        checks.argumentsFitSignature = true;
      } catch (error) {
        checks.argumentsFitSignature = false;
        notes.push(`Arguments do not fit ${signature}: ${errorText(error)}`);
      }
    }

    if (values) {
      fragment.inputs.forEach((param, index) =>
        annotateRoles(param, values![index], `args[${index}]`, ctx.roles, annotations),
      );
    }
  } else if (!raw) {
    // A top-level call's arguments are the input itself.
    values = claim.args;
  }

  // Nested calls: re-derived from the bytes, never from the decoder's list.
  const claimedChildren = claim.nestedCalls;
  const scripts = values ? scriptArguments(fragment, values) : [];
  // Prefer a script that carries calls: an empty one in front must not hide a
  // populated one behind it.
  const script = scripts.find((candidate) => candidate.calls.length > 0) ?? scripts[0] ?? null;

  if (scripts.length > 1) {
    notes.push(
      `Several arguments parse as EVMScripts (${scripts.map((s) => `args[${s.index}]`).join(", ")}); ` +
        `nested calls are read from args[${script!.index}].`,
    );
  }
  if (script) {
    ctx.scriptsParsed += 1;
  }

  if (claimedChildren.length > 0) {
    if (!values) {
      // Fall through: children are reported unresolved below.
    } else if (!script) {
      checks.nestedScript = false;
      notes.push(`The decoded view lists ${claimedChildren.length} nested call(s), but no argument is an EVMScript.`);
    } else {
      checks.nestedCallCount = script.calls.length === claimedChildren.length;
      if (!checks.nestedCallCount) {
        notes.push(
          `The decoded view lists ${claimedChildren.length} nested call(s); ` +
            `the script in args[${script.index}] has ${script.calls.length}.`,
        );
      }
    }
  } else if (script && script.calls.length > 0) {
    checks.nestedCallsListed = false;
    notes.push(
      `args[${script.index}] is a well-formed EVMScript carrying ${script.calls.length} call(s) ` +
        "that the decoded view does not list.",
    );
  }

  const failed = Object.values(checks).some((ok) => !ok);

  ctx.out.push({
    path,
    status: failed ? "MISMATCH" : fragment ? "VERIFIED" : "UNRESOLVED",
    to: raw ? raw.to : claimedTo,
    contractName: claim.contractName ?? null,
    functionName: claim.functionName,
    selector: actualSelector,
    signature: fragment ? fragment.format("sighash") : null,
    signatureSource: resolution.source,
    checks,
    notes,
    annotations,
  });

  // Children, in order.
  if (claimedChildren.length > 0 && !values) {
    claimedChildren.forEach((child, index) =>
      ctx.out.push(
        unverifiedChild(
          child,
          `${path}.${index + 1}`,
          "Could not be located in the raw bytes: the parent's signature is unresolved or its " +
            "arguments did not decode. See the parent's notes; --sig can supply its signature.",
          "UNRESOLVED",
        ),
      ),
    );
    return;
  }

  const rawChildren = script?.calls ?? [];
  const count = Math.max(claimedChildren.length, rawChildren.length);

  for (let index = 0; index < count; index += 1) {
    const childPath = `${path}.${index + 1}`;
    const childClaim = claimedChildren[index];
    const childRaw = rawChildren[index];

    if (childClaim && childRaw) {
      checkCall(childClaim, childRaw, childPath, index + 1, ctx);
    } else if (childRaw) {
      ctx.out.push(missingFromView(childRaw, childPath));
    } else if (childClaim) {
      ctx.out.push(
        unverifiedChild(
          childClaim,
          childPath,
          "Listed in the decoded view but absent from the raw script.",
          "MISMATCH",
        ),
      );
    }
  }
}

/**
 * Verifies decoded calls against the raw bytes they carry.
 *
 * Fully verified means every call — top-level and nested, at every depth —
 * matched, and none was left unresolved.
 */
export function verifyDecodedCalls(
  calls: readonly DecodedCall[],
  options: VerifyDecodedOptions = {},
): DecodedVerificationReport {
  const explicit = new Map<string, FunctionFragment>();
  for (const signature of options.signatures ?? []) {
    const fragment = parseSignature(signature);
    explicit.set(fragment.selector, fragment);
  }

  const ctx: Context = {
    explicit,
    roles: roleTable(options.roleNames ?? []),
    out: [],
    scriptsParsed: 0,
  };

  calls.forEach((call, index) => checkCall(call, null, `${index + 1}`, index + 1, ctx));

  const summary: Record<CallStatus, number> = { VERIFIED: 0, MISMATCH: 0, UNRESOLVED: 0 };
  for (const call of ctx.out) {
    summary[call.status] += 1;
  }

  const notes: string[] = [];
  if (ctx.scriptsParsed > 0) {
    notes.push(
      "Every nested call is sent with zero ETH attached (aragonOS CallsScript, spec ID 1). " +
        "Value can still move through what a call does, such as a token transfer.",
    );
  }

  return {
    verifiedAt: new Date().toISOString(),
    fullyVerified: summary.VERIFIED > 0 && summary.MISMATCH === 0 && summary.UNRESOLVED === 0,
    summary,
    calls: ctx.out,
    notes,
    notChecked: [...NOT_CHECKED],
  };
}
