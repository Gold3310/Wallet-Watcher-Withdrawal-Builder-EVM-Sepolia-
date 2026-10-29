/**
 * Who pays for gas, and whether the sender can pay for it at all.
 *
 * WHAT THIS IS
 *
 * Two implementations behind one interface, so the difference between "the
 * sender pays" and "someone else pays" is a configuration choice rather than a
 * code path duplicated across every call site:
 *
 * - `DirectRelayer` — the sender's own ETH pays, via the node. This is what
 *   already happens.
 * - `SponsoredRelayer` — a signed transaction is handed to an HTTP relay that
 *   submits it and pays.
 *
 * WHAT IT IS NOT, stated so nobody builds on a misunderstanding
 *
 * This is **not** a working Biconomy integration. Biconomy's MEE replaces
 * bundlers and paymasters for **smart accounts**: the user signs a message, not
 * a transaction, and the account executes it. The wallets here are plain EOAs
 * derived from a mnemonic. An EOA cannot sign a UserOperation, so MEE's
 * sponsored flow does not apply to them without first moving to a smart account.
 *
 * What an EOA *can* do is hand a raw signed transaction to a relay that pays
 * for it — which is what `SponsoredRelayer` models. Standing that up needs an
 * API key and outbound network access, neither of which exists here, so the
 * implementation is complete, tested against a mock, and unconfigured by
 * default.
 *
 * THE PART THAT WORKS TODAY
 *
 * `describeGasReadiness` — whether an address can afford the transaction it is
 * about to send. That is the question worth answering before anything else,
 * because it separates the two failure modes that look identical from the
 * outside:
 *
 * - **No balance.** Sponsoring gas achieves nothing. There is no claim to
 *   exercise and no amount of paid gas creates one.
 * - **Balance, no ETH.** Sponsoring gas is exactly the fix.
 *
 * Conflating them is how "just make it gasless" turns into a feature that
 * costs money and unlocks nothing.
 */
import type { JsonRpcProvider } from "ethers";
import { formatEther } from "ethers";
import { config } from "../../config/index.js";

export interface SubmitResult {
  hash: string;
}

export interface Relayer {
  /** Who paid, for the response and the logs. */
  readonly name: string;
  /** Whether the sender's own ETH funds this submission. */
  readonly senderPaysGas: boolean;
  submit(rawSignedTransaction: string): Promise<SubmitResult>;
}

/** The sender's ETH pays, submitted straight through the node. */
export class DirectRelayer implements Relayer {
  readonly name = "direct";
  readonly senderPaysGas = true;

  constructor(private provider: JsonRpcProvider) {}

  async submit(rawSignedTransaction: string): Promise<SubmitResult> {
    const response = await this.provider.broadcastTransaction(
      rawSignedTransaction,
    );
    return { hash: response.hash };
  }
}

export interface SponsoredRelayerOptions {
  endpoint: string;
  apiKey: string | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * A third party submits and pays.
 *
 * The request shape is the conventional one — a JSON body carrying the signed
 * transaction, authenticated with a bearer key — because that is what relay
 * services generally accept. It is deliberately not modelled on any one
 * vendor's SDK, since committing to an SDK this service cannot reach or test
 * would be guessing with a dependency attached.
 */
export class SponsoredRelayer implements Relayer {
  readonly name = "sponsored";
  readonly senderPaysGas = false;

  constructor(private options: SponsoredRelayerOptions) {}

  async submit(rawSignedTransaction: string): Promise<SubmitResult> {
    if (!this.options.apiKey) {
      throw new Error(
        `GASLESS_RELAY_ENDPOINT is set but GASLESS_API_KEY is not. Refusing to ` +
          `send a signed transaction to a relay unauthenticated — an unsigned ` +
          `submission is an open relay for anyone who finds the endpoint.`,
      );
    }

    const doFetch = this.options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(this.options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ signedTransaction: rawSignedTransaction }),
      });
    } catch (error) {
      throw new Error(
        `Could not reach the gasless relay at ${this.options.endpoint}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Gasless relay rejected the transaction with ${response.status}: ` +
          `${(await response.text()).slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as { hash?: string };

    if (typeof body.hash !== "string") {
      throw new Error(
        "Gasless relay responded without a transaction hash, so the " +
          "submission cannot be confirmed. Treat it as unsent.",
      );
    }

    return { hash: body.hash };
  }
}

/** Chooses from configuration: sponsored when an endpoint is set, else direct. */
export function selectRelayer(
  provider: JsonRpcProvider,
  endpoint: string | null,
  apiKey: string | null,
  fetchImpl?: typeof fetch,
): Relayer {
  if (endpoint === null || endpoint.trim() === "") {
    return new DirectRelayer(provider);
  }

  return new SponsoredRelayer({
    endpoint: endpoint.trim(),
    apiKey,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

export function getRelayer(
  provider: JsonRpcProvider,
  fetchImpl?: typeof fetch,
): Relayer {
  return selectRelayer(
    provider,
    config.gaslessRelayEndpoint,
    config.gaslessApiKey,
    fetchImpl,
  );
}

export interface GasReadiness {
  /** gasLimit x maxFeePerGas, the ceiling on what the sender must cover. */
  costWei: bigint;
  balanceWei: bigint;
  sufficient: boolean;
  /** How much more ETH is needed. Zero when sufficient. */
  shortfallWei: bigint;
  message: string;
}

/**
 * Whether an address can afford the transaction it is about to send.
 *
 * Uses `maxFeePerGas` rather than a spot price because that is the ceiling the
 * sender must actually cover: a transaction priced at the current base fee can
 * still fail when the next block is fuller.
 */
export function describeGasReadiness(
  balanceWei: bigint,
  gasLimit: bigint,
  maxFeePerGas: bigint,
): GasReadiness {
  const costWei = gasLimit * maxFeePerGas;
  const sufficient = balanceWei >= costWei;
  const shortfallWei = sufficient ? 0n : costWei - balanceWei;

  return {
    costWei,
    balanceWei,
    sufficient,
    shortfallWei,
    message: sufficient
      ? `Has ${formatEther(balanceWei)} ETH, enough for an estimated ` +
        `${formatEther(costWei)} ETH of gas.`
      : `Needs ${formatEther(costWei)} ETH for gas but holds ` +
        `${formatEther(balanceWei)} ETH — short by ` +
        `${formatEther(shortfallWei)} ETH. Sponsoring gas would clear this; ` +
        `it would do nothing for an address that holds no balance to move.`,
  };
}
