/**
 * Can you become the owner, and would it get you anything?
 *
 * This exists because the question has been asked repeatedly and answered in
 * chat, which is not an answer that survives the conversation. It is computed
 * here from the contract's own ABI each time it runs, so the reply is evidence
 * rather than recollection.
 *
 * Two separate questions, deliberately kept apart, because they fail for
 * completely different reasons:
 *
 *   1. **Can the owner role be transferred to you?** `transferOwnership` is
 *      `onlyOwner`, so it can only be sent by whoever holds the role now. That
 *      is a question about keys, and the answer depends on whether this service
 *      can sign for the current owner.
 *
 *   2. **Would holding it help?** That is a question about the ABI. If no
 *      owner-gated function moves value, then owning the contract grants the
 *      right to administer it and nothing more — and the honest answer is "it
 *      would not help", however much you might want it to.
 *
 * The second is the one people assume away. Titles sound like control. On this
 * contract the owner can set proposer rights, hand the role on, or renounce it
 * — and cannot touch a single wei. Saying so from the ABI beats saying so from
 * memory, because it stays true if the contract ever changes.
 */
import { Interface, type FunctionFragment } from "ethers";

/**
 * Functions gated by `onlyOwner`, taken from the verified source of the
 * tracked contract rather than guessed from names.
 */
export const OWNER_GATED_FUNCTIONS = [
  "setProposer",
  "transferOwnership",
  "renounceOwnership",
] as const;

/**
 * Names that move value out of a contract. A conservative list: it is better
 * to flag a function for a human to look at than to silently omit one.
 */
const VALUE_MOVING_NAMES =
  /^(withdraw|withdrawTo|transfer|transferFrom|mint|burn|sweep|rescue|skim|send|push)$/;

export interface ValueMovingFunction {
  name: string;
  /** Whether it is gated by `onlyOwner`. */
  ownerGated: boolean;
  /** Why it counts as moving value. */
  reason: "payable" | "name";
}

export interface OwnershipAnalysis {
  contract: string;
  /** Live owner, or null when the call failed. */
  owner: string | null;
  /** Whether the role is still where deployment put it. */
  ownerIsDeployer: boolean | null;
  /** Whether the role is held by this service's configured owner address. */
  ownerIsServiceOwner: boolean | null;
  /**
   * Whether this service could send `transferOwnership`. Only ever true when
   * the current owner is a wallet it holds keys for, since the call must be
   * signed by the current owner.
   */
  serviceCanChangeOwner: boolean;
  /** Why it can or cannot, which is the part worth reading. */
  changeOwnerReason: string;
  /** Functions the owner may call, from the verified source. */
  ownerGatedFunctions: string[];
  /** Everything that can move value, and whether the owner controls it. */
  valueMovingFunctions: ValueMovingFunction[];
  /**
   * The crux: whether any owner-gated function moves value. False here means
   * the role is administrative only.
   */
  ownerCanMoveValue: boolean;
  verdict: string;
}

export interface OwnershipInput {
  contract: string;
  owner: string | null;
  /** The address that deployed the contract, if known. */
  deployer: string | null;
  /** This service's configured owner address, if set. */
  serviceOwner: string | null;
  /** Addresses this service can sign for, lowercased. */
  signableAddresses: string[];
  abi: readonly unknown[];
  /**
   * Functions gated by `onlyOwner`. Defaults to the set read from the tracked
   * contract's verified source.
   *
   * An input rather than a constant for a specific reason: with it hardcoded,
   * this analysis could only ever answer "the owner cannot move value", which
   * makes it a rubber stamp rather than a check. Pass the real gating for
   * whatever contract is under inspection.
   */
  ownerGatedFunctions?: readonly string[];
}

function compare(a: string | null, b: string | null): boolean | null {
  if (a === null || b === null) {
    return null;
  }
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Pure analysis: given an ABI and who holds the role, say what the role is
 * worth. Kept separate from the RPC read so the reasoning can be tested
 * against any contract, including ones where the owner *can* move value.
 */
export function analyseOwnership(input: OwnershipInput): OwnershipAnalysis {
  const iface = new Interface(input.abi as never);
  const functions = iface.fragments.filter(
    (fragment): fragment is FunctionFragment => fragment.type === "function",
  );

  const gated = new Set<string>(
    input.ownerGatedFunctions ?? OWNER_GATED_FUNCTIONS,
  );

  const ownerGatedFunctions = functions
    .map((fragment) => fragment.name)
    .filter((name) => gated.has(name))
    .sort();

  const valueMovingFunctions: ValueMovingFunction[] = functions
    .filter(
      (fragment) =>
        fragment.payable || VALUE_MOVING_NAMES.test(fragment.name),
    )
    .map((fragment) => ({
      name: fragment.name,
      ownerGated: gated.has(fragment.name),
      reason: fragment.payable ? ("payable" as const) : ("name" as const),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const ownerCanMoveValue = valueMovingFunctions.some(
    (fn) => fn.ownerGated,
  );

  const ownerIsDeployer = compare(input.owner, input.deployer);
  const ownerIsServiceOwner = compare(input.owner, input.serviceOwner);

  const signable = new Set(input.signableAddresses.map((a) => a.toLowerCase()));
  const serviceCanChangeOwner =
    input.owner !== null && signable.has(input.owner.toLowerCase());

  const changeOwnerReason = serviceCanChangeOwner
    ? `This service holds a key for ${input.owner}, so it could sign ` +
      `transferOwnership. Whether that is a good idea is a separate question.`
    : input.owner === null
      ? `The owner could not be read, so nothing is concluded.`
      : `transferOwnership is onlyOwner: it must be signed by the current ` +
        `owner (${input.owner}), and that address is not a wallet this ` +
        `service has keys for. No code path produces that signature.`;

  return {
    contract: input.contract,
    owner: input.owner,
    ownerIsDeployer,
    ownerIsServiceOwner,
    serviceCanChangeOwner,
    changeOwnerReason,
    ownerGatedFunctions,
    valueMovingFunctions,
    ownerCanMoveValue,
    verdict: verdictFor({
      owner: input.owner,
      serviceCanChangeOwner,
      ownerCanMoveValue,
      ownerGatedFunctions,
    }),
  };
}

function verdictFor(input: {
  owner: string | null;
  serviceCanChangeOwner: boolean;
  ownerCanMoveValue: boolean;
  ownerGatedFunctions: string[];
}): string {
  if (input.owner === null) {
    return (
      `The contract's owner could not be read, so nothing is concluded here. ` +
      `Check the RPC endpoint and that the contract is on this chain.`
    );
  }

  const parts: string[] = [];

  parts.push(
    `The owner is ${input.owner}. ` +
      (input.serviceCanChangeOwner
        ? `This service holds that key, so it could transfer the role.`
        : `transferOwnership is onlyOwner, so only that address can move the ` +
          `role — and it is not a wallet this service can sign for. No amount ` +
          `of tooling changes that; it is a fact about who holds a private key.`),
  );

  if (input.ownerCanMoveValue) {
    parts.push(
      `Holding the role WOULD grant access to value: an owner-gated function ` +
        `here moves funds.`,
    );
  } else {
    parts.push(
      `Holding the role would not move a single wei. Every owner-gated ` +
        `function is administrative — ` +
        `${input.ownerGatedFunctions.join(", ") || "none that the ABI exposes"} — ` +
        `and nothing the owner can call transfers ETH or tokens. The functions ` +
        `that do move value are ungated: they answer to whoever holds a ` +
        `balance, not to whoever holds the title. Being made owner would give ` +
        `you a role, not a claim.`,
    );
  }

  return parts.join(" ");
}

/** Reads the live owner and analyses the role against the contract's ABI. */
export async function readOwnership(
  provider: { call(tx: { to: string; data: string }): Promise<string> },
  contract: string,
  options: {
    abi: readonly unknown[];
    deployer: string | null;
    serviceOwner: string | null;
    signableAddresses: string[];
    ownerGatedFunctions?: readonly string[];
  },
): Promise<OwnershipAnalysis> {
  const iface = new Interface(options.abi as never);

  let owner: string | null = null;
  try {
    const result = await provider.call({
      to: contract,
      data: iface.encodeFunctionData("owner"),
    });
    owner = iface.decodeFunctionResult("owner", result)[0] as string;
  } catch {
    owner = null;
  }

  return analyseOwnership({
    contract,
    owner,
    deployer: options.deployer,
    serviceOwner: options.serviceOwner,
    signableAddresses: options.signableAddresses,
    abi: options.abi,
    ...(options.ownerGatedFunctions === undefined
      ? {}
      : { ownerGatedFunctions: options.ownerGatedFunctions }),
  });
}
