/**
 * Per-wallet transaction nonce allocation.
 *
 * `provider.getTransactionCount(address, "pending")` alone is not safe under
 * concurrency: two requests in flight both read the same pending count and both
 * sign for it, so one of the two transactions can never land. The fix is a
 * synchronous critical section — the network read is awaited first, then the
 * compare-and-reserve happens with no `await` in between, so interleaved
 * callers still get distinct nonces.
 *
 * This covers concurrency within one process. Running multiple instances
 * against the same wallet needs a shared allocator (or a single signer).
 */
import type { JsonRpcProvider } from "ethers";

const nextNonceByWallet = new Map<number, number>();

export async function allocateNonce(
  walletIndex: number,
  address: string,
  provider: JsonRpcProvider,
): Promise<number> {
  const networkNonce = await provider.getTransactionCount(address, "pending");
  const cached = nextNonceByWallet.get(walletIndex) ?? 0;
  const next = Math.max(cached, networkNonce);

  // No await between the read above and this write.
  nextNonceByWallet.set(walletIndex, next + 1);

  return next;
}

/**
 * Hand a nonce back when the transaction it was allocated for never made it to
 * the network, so the next allocation reuses it. Only rewinds if nothing has
 * been allocated since.
 */
export function releaseNonce(walletIndex: number, nonce: number): void {
  if (nextNonceByWallet.get(walletIndex) === nonce + 1) {
    nextNonceByWallet.set(walletIndex, nonce);
  }
}

/** Forget cached nonce state, e.g. after an operator-cleared stuck tx. */
export function resetNonce(walletIndex?: number): void {
  if (walletIndex === undefined) {
    nextNonceByWallet.clear();
    return;
  }
  nextNonceByWallet.delete(walletIndex);
}
