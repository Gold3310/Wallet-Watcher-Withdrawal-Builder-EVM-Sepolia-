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
