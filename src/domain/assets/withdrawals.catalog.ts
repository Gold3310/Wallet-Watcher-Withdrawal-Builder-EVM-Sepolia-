/**
 * Every way value can move out of this system, in one place.
 *
 * Built from the contract's ABI rather than typed out by hand, because a
 * hand-written list is a list that goes stale the moment anything changes and
 * quietly starts lying. Anything found in the ABI that this file does not
 * recognise is still listed — flagged `unclassified` — on the principle that
 * showing you something unexpected beats omitting it.
 *
 * Each entry answers the only questions that matter here: what it does, what
 * it needs from you, whether this service can run it, and if not, exactly
 * what stops it.
 */
import { FunctionFragment, Interface } from "ethers";
import {
  TRACKED_CONTRACT_ABI,
  trackedContractInterface,
} from "./abi.js";
import { OWNER_GATED_FUNCTIONS } from "./ownership.js";

export type WithdrawalLayer = "contract" | "api" | "cli";

export type WithdrawalKind =
  /** Burn ABT, receive ETH. The only route to the reserve. */
  | "redemption"
  /** Move tokens between addresses. */
  | "transfer"
  /** Wrap ETH into ABT. */
  | "wrap"
  /** Grant a spending allowance. */
  | "approval"
  /** Owner-only, and it moves nothing. */
  | "administrative"
  /** Build or broadcast a transaction through this service. */
  | "service"
  /** Build a withdrawal without broadcasting. */
  | "inspection"
  /** In the ABI, but not classified here. Shown, never hidden. */
  | "unclassified";

export interface WithdrawalCapability {
  id: string;
  name: string;
  layer: WithdrawalLayer;
  kind: WithdrawalKind;
  /** Full signature with types, e.g. `withdraw(uint256 wad)`. */
  signature: string;
  /** 4-byte selector, for contract functions. */
  selector?: string;
  /** What it actually does. */
  summary: string;
  /** What you must be holding, or have, for it to work. */
  requirement: string;
  /** Whether this service can execute it for you. */
  executableHere: boolean;
  /** Precisely what prevents it, when it cannot. */
  blocker?: string;
  /** Copy-pasteable invocation. */
  invoke: string;
}

interface Classification {
  kind: WithdrawalKind;
  summary: string;
  requirement: string;
  executableHere: boolean;
  blocker?: string;
  /** `{selector}` is replaced with the real 4-byte selector. */
  invoke?: string;
}

/**
 * What each contract function needs, read from the verified source. Anything
 * absent lands in `unclassified` rather than being dropped.
 */
const CLASSIFICATIONS: Record<string, Classification> = {
  withdraw: {
    kind: "redemption",
    summary:
      "Burns ABT 1:1 and sends you the ETH. Ungated — no owner approval, no " +
      "proposer rights. The only function that reaches the contract's " +
      "42.591 ETH reserve.",
    requirement: "An ABT balance at an address you can sign for.",
    executableHere: true,
    invoke:
      `curl -X POST http://localhost:3000/assets/unwrap \n` +
      `  -H 'x-api-token: <token>' -H 'content-type: application/json' \n` +
      `  -d '{"fromWalletIndex":0,"amountWei":"1000000000000000000","broadcast":false}'\n` +
      `  (calldata: {selector} + 32-byte amount)`,
  },
  transfer: {
    kind: "transfer",
    summary:
      "Sends ABT to any address. Unrestricted to everywhere except the " +
      "hubPool — transfers there need proposer approval, or that you are not " +
      "the current root-bundle proposer.",
    requirement: "An ABT balance, and a destination on the allowlist.",
    executableHere: true,
    invoke:
      `No service route exposes token transfers yet. Calldata: ` +
      `{selector} + 32-byte destination + 32-byte amount, signed from a ` +
      `wallet that holds ABT.`,
  },
  transferFrom: {
    kind: "transfer",
    summary:
      "Sends ABT on someone else's behalf. Same destination check as " +
      "transfer, plus an allowance from the owner of the tokens.",
    requirement: "A prior approve() from the token holder.",
    executableHere: true,
    invoke:
      `No service route exposes this. Calldata: {selector} + 32-byte from + ` +
      `32-byte to + 32-byte amount.`,
  },
  deposit: {
    kind: "wrap",
    summary:
      "Wraps ETH into ABT at 1:1. Puts value into the token, which is the " +
      "opposite direction to every other entry here.",
    requirement: "ETH in the calling wallet.",
    executableHere: true,
    invoke:
      `No service route exposes this. Payable call, no arguments — send ETH ` +
      `with calldata {selector}.`,
  },
  approve: {
    kind: "approval",
    summary: "Grants another address the right to move your ABT.",
    requirement: "Nothing beyond a wallet this service can sign for.",
    executableHere: true,
    invoke:
      `No service route exposes this. Calldata: {selector} + 32-byte spender ` +
      `+ 32-byte amount.`,
  },
  setProposer: {
    kind: "administrative",
    summary: "Marks an address as an approved hubPool proposer. Moves nothing.",
    requirement: "The owner role.",
    executableHere: false,
    blocker:
      "onlyOwner, and the owner is the Risk Labs deployer — not a wallet " +
      "this service has keys for.",
    invoke: `Not reachable from here: {selector} requires the current owner's signature.`,
  },
  transferOwnership: {
    kind: "administrative",
    summary: "Hands the owner role to another address. Moves nothing.",
    requirement: "The owner role — held by Risk Labs.",
    executableHere: false,
    blocker:
      "onlyOwner: only the current owner can send it, and that key is not " +
      "here. See GET /assets/ownership.",
    invoke: `Not reachable from here: {selector} requires the current owner's signature.`,
  },
  renounceOwnership: {
    kind: "administrative",
    summary: "Abandons the owner role, leaving nobody in charge.",
    requirement: "The owner role.",
    executableHere: false,
    blocker:
      "onlyOwner, and it would make the situation worse rather than better.",
    invoke: `Not reachable from here: {selector} requires the current owner's signature.`,
  },
};

const GATED = new Set<string>(OWNER_GATED_FUNCTIONS);

function humanSignature(fragment: FunctionFragment): string {
  const inputs = fragment.inputs
    .map((input) => `${input.type} ${input.name || "arg"}`)
    .join(", ");
  return `${fragment.name}(${inputs})`;
}

/** Everything the contract itself can be asked to do that changes state. */
export function contractCapabilities(
  abi: readonly unknown[] = TRACKED_CONTRACT_ABI as readonly unknown[],
): WithdrawalCapability[] {
  const iface = new Interface(abi as never);

  return iface.fragments
    .filter((fragment) => fragment.type === "function")
    .map((fragment) => fragment as FunctionFragment)
    .filter(
      (fragment) =>
        fragment.stateMutability !== "view" &&
        fragment.stateMutability !== "pure",
    )
    .map((fragment) => {
      const known = CLASSIFICATIONS[fragment.name];
      const classification: Classification = known ?? {
        kind: "unclassified",
        summary:
          "In the contract ABI but not classified here. Check the verified " +
          "source before relying on it.",
        requirement: "Unknown — not classified.",
        executableHere: false,
        blocker: "Unclassified, so its requirements have not been established.",
      };

      return {
        id: `contract:${fragment.name}`,
        name: fragment.name,
        layer: "contract" as const,
        kind: classification.kind,
        signature: humanSignature(fragment),
        selector: fragment.selector,
        summary: classification.summary,
        requirement: classification.requirement,
        executableHere: classification.executableHere,
        ...(classification.blocker === undefined
          ? {}
          : { blocker: classification.blocker }),
        invoke:
          classification.invoke?.replace(/\{selector\}/g, fragment.selector) ??
          `No route in this service. Build calldata manually: ` +
            `${fragment.selector} + ABI-encoded arguments.`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The routes this service exposes for moving value. */
export function apiCapabilities(): WithdrawalCapability[] {
  return [
    {
      id: "api:assets:unwrap",
      name: "POST /assets/unwrap",
      layer: "api",
      kind: "redemption",
      signature: "unwrap(fromWalletIndex, amountWei?, broadcast?)",
      summary:
        "Builds withdraw(uint256) for a derived wallet — burn ABT, take ETH. " +
        "Set broadcast=false to inspect the calldata before anything is sent.",
      requirement:
        "API token for the owner, plus an ABT balance on that wallet index.",
      executableHere: true,
      invoke:
        `curl -X POST http://localhost:3000/assets/unwrap \n` +
        `  -H 'x-api-token: <token>' -H 'content-type: application/json' \n` +
        `  -d '{"fromWalletIndex":0,"amountWei":"1000000000000000000","broadcast":false}'`,
    },
    {
      id: "api:withdrawals:create",
      name: "POST /withdrawals",
      layer: "api",
      kind: "service",
      signature: "withdraw(fromWalletIndex, toAddress, amountWei, broadcast?)",
      summary:
        "Builds a plain ETH transfer from a derived wallet to an allowlisted " +
        "address. This spends ETH you already hold — it does not touch ABT.",
      requirement:
        "API token, ETH on that wallet, and a destination in " +
        "WITHDRAWAL_ALLOWLIST.",
      executableHere: true,
      invoke:
        `curl -X POST http://localhost:3000/withdrawals \n` +
        `  -H 'x-api-token: <token>' -H 'content-type: application/json' \n` +
        `  -d '{"fromWalletIndex":0,"toAddress":"0x…","amountWei":"1000000000000000","broadcast":false}'`,
    },
  ];
}

/** The commands that need no running server. */
export function cliCapabilities(): WithdrawalCapability[] {
  return [
    {
      id: "cli:withdrawals",
      name: "npm run withdrawals",
      layer: "cli",
      kind: "inspection",
      signature: "withdrawals [--id <id>] [--json]",
      summary:
        "Prints this entire catalogue, so everything available is visible " +
        "without a server, an endpoint, or a network.",
      requirement: "Nothing. Works offline.",
      executableHere: true,
      invoke: "npm run withdrawals",
    },
    {
      id: "cli:addresses:confirm",
      name: "npm run addresses:confirm",
      layer: "cli",
      kind: "inspection",
      signature: "addresses:confirm [--offline] [--fixture <path>]",
      summary:
        "Shows every address, its balance, its share of supply, its ETH, and " +
        "whether this service can sign for it — plus the ownership analysis. " +
        "`--offline` renders it from recorded data.",
      requirement: "Nothing for --offline. A mainnet RPC endpoint otherwise.",
      executableHere: true,
      invoke: "npm run addresses:confirm -- --offline",
    },
    {
      id: "cli:wallet:derive",
      name: "npm run wallet:derive",
      layer: "cli",
      kind: "inspection",
      signature: "wallet:derive [index]",
      summary:
        "Shows the address at a derived index, so you know where to send " +
        "tokens before asking this service to move them.",
      requirement: "Nothing — derivation is offline.",
      executableHere: true,
      invoke: "npm run wallet:derive -- 0",
    },
  ];
}

export interface WithdrawalCatalog {
  contract: string;
  /** Everything, across all layers. */
  capabilities: WithdrawalCapability[];
  /** The ones that could actually run right now. */
  available: string[];
  /** The ones that cannot, with the reason. */
  blocked: { id: string; reason: string }[];
  /** Anything in the ABI this file did not recognise. */
  unclassified: string[];
  /** The one sentence that matters. */
  verdict: string;
}

export function buildWithdrawalCatalog(
  abi: readonly unknown[] = TRACKED_CONTRACT_ABI as readonly unknown[],
): WithdrawalCatalog {
  const contract = contractCapabilities(abi);
  const capabilities = [...contract, ...apiCapabilities(), ...cliCapabilities()];

  const available = capabilities
    .filter((cap) => cap.executableHere)
    .map((cap) => cap.id);

  const blocked = capabilities
    .filter((cap) => cap.blocker !== undefined)
    .map((cap) => ({ id: cap.id, reason: cap.blocker as string }));

  const unclassified = capabilities
    .filter((cap) => cap.kind === "unclassified")
    .map((cap) => cap.id);

  // Scoped to the contract: the API's unwrap route is a way to *call* the
  // redemption, not a second independent one, so it must not be what the
  // verdict means when it says "the only route to the ETH".
  const redemption = contract.find((cap) => cap.kind === "redemption");

  const verdict =
    unclassified.length > 0
      ? `This catalogue contains ${unclassified.length} function(s) the ABI ` +
        `exposes that have not been classified: ${unclassified.join(", ")}. ` +
        `They are shown rather than omitted, but check the verified source ` +
        `before relying on any of them.`
      : redemption !== undefined
        ? `${redemption.name} is the only route to the contract's ETH. It is ` +
          `ungated — no owner approval needed — and it requires exactly one ` +
          `thing: holding an ABT balance at an address you can sign for. ` +
          `Everything administrative is blocked, and blocked on a key that is ` +
          `not here, not on anything this code can influence.`
        : `No value-moving function was found in this ABI. Nothing here can ` +
          `be withdrawn.`;

  return {
    contract: "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea",
    capabilities,
    available,
    blocked,
    unclassified,
    verdict,
  };
}

/** Single capability by id, for `GET /assets/withdrawals/:id`. */
export function findWithdrawalCapability(
  id: string,
  abi: readonly unknown[] = TRACKED_CONTRACT_ABI as readonly unknown[],
): WithdrawalCapability | undefined {
  return buildWithdrawalCatalog(abi).capabilities.find((cap) => cap.id === id);
}
