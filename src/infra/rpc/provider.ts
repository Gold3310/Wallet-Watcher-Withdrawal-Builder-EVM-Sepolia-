import { JsonRpcProvider } from "ethers";
import { config } from "../../config/index.js";

let provider: JsonRpcProvider | null = null;

export function getProvider(): JsonRpcProvider {
  if (!provider) {
    provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  }
  return provider;
}

export function setProvider(customProvider: JsonRpcProvider): void {
  provider = customProvider;
}

export function resetProvider(): void {
  provider = null;
}

/**
 * Fails fast, with a message that names the setting to check.
 *
 * Without this, an unreachable node is indistinguishable from a hang: ethers
 * retries the initial network detection indefinitely, printing a line a second
 * forever. Better to say "your RPC URL is wrong" in ten seconds than to look
 * like a frozen process.
 */
export async function assertReachable(
  target: JsonRpcProvider = getProvider(),
  timeoutMs = 10_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      target.getBlockNumber(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    throw new Error(
      `Could not reach the ${config.network} node at ${config.rpcUrl} within ` +
        `${timeoutMs / 1000}s. Check ${config.networkConfig.rpcUrlEnv} in your ` +
        `.env — a wrong URL otherwise retries forever.`,
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
