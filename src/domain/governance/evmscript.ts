/**
 * Aragon EVMScripts — the byte format Aragon apps carry their actions in.
 *
 * `Agent.forward(bytes)`, `Voting.newVote(bytes, …)` and Easy Track motions all
 * take a script in this shape (spec ID 1, aragonOS `CallsScript`):
 *
 *   specId          4 bytes   0x00000001
 *   repeated:
 *     target       20 bytes
 *     length        4 bytes   uint32, big-endian
 *     calldata     `length` bytes
 *
 * Parsed exactly the way aragonOS executes it: every call needs a full 24-byte
 * header, its calldata must fit inside the script, and the last call must end
 * on the last byte. A script that fails any of those would revert on chain with
 * EVMCALLS_INVALID_LENGTH, so it is rejected here rather than half-read.
 *
 * Two execution facts worth keeping next to the format, because reviewers ask:
 * CallsScript sends every call with **zero ETH value**, and if any call fails
 * the **whole script reverts**.
 *
 * Pure byte handling: no network, no signing.
 */
import { getAddress, getBytes, hexlify } from "ethers";

export const CALLS_SCRIPT_SPEC_ID = "0x00000001";

const SPEC_ID_LENGTH = 4;
const ADDRESS_LENGTH = 20;
const LENGTH_FIELD = 4;
const HEADER_LENGTH = ADDRESS_LENGTH + LENGTH_FIELD;

export interface ScriptCall {
  /** Position in the script, 0-based. */
  index: number;
  /** Byte offset of this call's header inside the script. */
  offset: number;
  /** Target, EIP-55 checksummed. */
  to: string;
  /** Calldata, 0x-prefixed lowercase hex. May be empty ("0x"). */
  calldata: string;
  /** First four bytes of calldata, or null when there are fewer than four. */
  selector: string | null;
}

export class EvmScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmScriptError";
  }
}

function toBytes(script: string | Uint8Array): Uint8Array {
  if (script instanceof Uint8Array) {
    return script;
  }
  try {
    return getBytes(script);
  } catch {
    throw new EvmScriptError("Script is not valid 0x-prefixed hex with an even number of digits.");
  }
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    bytes[at]! * 0x1000000 +
    ((bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!)
  );
}

/** Returns the 4-byte spec ID as hex, or throws when the script is too short to have one. */
export function specIdOf(script: string | Uint8Array): string {
  const bytes = toBytes(script);
  if (bytes.length < SPEC_ID_LENGTH) {
    throw new EvmScriptError(
      `Script is ${bytes.length} byte(s) long, shorter than its 4-byte spec ID.`,
    );
  }
  return hexlify(bytes.slice(0, SPEC_ID_LENGTH));
}

/**
 * Splits a spec-1 EVMScript into its calls, in execution order.
 *
 * Throws EvmScriptError when the bytes are not a well-formed CallsScript. An
 * empty script (the spec ID alone) is valid and yields no calls.
 */
export function parseEvmScript(script: string | Uint8Array): ScriptCall[] {
  const bytes = toBytes(script);
  const specId = specIdOf(bytes);

  if (specId !== CALLS_SCRIPT_SPEC_ID) {
    throw new EvmScriptError(
      `Unsupported spec ID ${specId}: only CallsScript (${CALLS_SCRIPT_SPEC_ID}) is understood.`,
    );
  }

  const calls: ScriptCall[] = [];
  let location = SPEC_ID_LENGTH;

  while (location < bytes.length) {
    if (bytes.length - location < HEADER_LENGTH) {
      throw new EvmScriptError(
        `Call ${calls.length + 1} at byte ${location}: ${bytes.length - location} byte(s) left, ` +
          `a call header needs ${HEADER_LENGTH}.`,
      );
    }

    const to = getAddress(hexlify(bytes.slice(location, location + ADDRESS_LENGTH)));
    const length = readUint32(bytes, location + ADDRESS_LENGTH);
    const start = location + HEADER_LENGTH;
    const end = start + length;

    if (end > bytes.length) {
      throw new EvmScriptError(
        `Call ${calls.length + 1} at byte ${location}: declares ${length} byte(s) of calldata, ` +
          `only ${bytes.length - start} remain.`,
      );
    }

    const calldata = hexlify(bytes.slice(start, end));
    calls.push({
      index: calls.length,
      offset: location,
      to,
      calldata,
      selector: length >= 4 ? calldata.slice(0, 10) : null,
    });

    location = end;
  }

  return calls;
}

/** Non-throwing variant: the calls, or null when the bytes are not a CallsScript. */
export function tryParseEvmScript(script: string | Uint8Array): ScriptCall[] | null {
  try {
    return parseEvmScript(script);
  } catch {
    return null;
  }
}

/** Builds a spec-1 EVMScript. The inverse of parseEvmScript. */
export function encodeEvmScript(calls: ReadonlyArray<{ to: string; calldata: string }>): string {
  const parts: string[] = [CALLS_SCRIPT_SPEC_ID.slice(2)];

  for (const call of calls) {
    const target = getAddress(call.to).slice(2).toLowerCase();
    const data = hexlify(getBytes(call.calldata)).slice(2);
    const length = data.length / 2;

    if (length > 0xffffffff) {
      throw new EvmScriptError(`Calldata for ${call.to} exceeds the uint32 length field.`);
    }

    parts.push(target, length.toString(16).padStart(8, "0"), data);
  }

  return `0x${parts.join("")}`;
}
