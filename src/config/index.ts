import dotenv from "dotenv";

dotenv.config();

const MIN_WALLET_COUNT = 1;
const MAX_WALLET_COUNT = 20;
const TESTNET_MAX_GRANT_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAINNET_MAX_GRANT_EXPIRY_SECONDS = 24 * 60 * 60; // 1 day
const DEFAULT_MAINNET_MAX_TX_VALUE_WEI = 100_000_000_000_000_000n; // 0.1 ETH

/** Networks this service can run against. */
export const NETWORKS = {
  sepolia: {
    name: "sepolia",
    chainId: 11155111,
    rpcUrlEnv: "SEPOLIA_RPC_URL",
    testnet: true,
  },
  mainnet: {
    name: "mainnet",
    chainId: 1,
    rpcUrlEnv: "MAINNET_RPC_URL",
    testnet: false,
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

export interface NetworkConfig {
  name: NetworkName;
  chainId: number;
  rpcUrlEnv: string;
  testnet: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseWalletCount(raw: string | undefined): number {
  const count = Number(raw ?? "5");
  if (
    !Number.isInteger(count) ||
    count < MIN_WALLET_COUNT ||
    count > MAX_WALLET_COUNT
  ) {
    throw new Error(
      `WALLET_COUNT must be an integer between ${MIN_WALLET_COUNT} and ${MAX_WALLET_COUNT}`,
    );
  }
  return count;
}

function parseNetwork(raw: string | undefined): NetworkName {
  const name = (raw ?? "").trim().toLowerCase() || "sepolia";

  if (!Object.prototype.hasOwnProperty.call(NETWORKS, name)) {
    throw new Error(
      `CHAIN must be one of: ${Object.keys(NETWORKS).join(", ")} (got: ${raw})`,
    );
  }

  return name as NetworkName;
}

function parseWeiEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new Error(`${name} must be a valid unsigned integer string of wei`);
  }

  if (value <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }

  return value;
}

const networkConfig: NetworkConfig = NETWORKS[parseNetwork(process.env.CHAIN)];

/**
 * Mainnet is real money, so running against it is an explicit opt-in rather
 * than a side effect of setting CHAIN=mainnet.
 */
if (!networkConfig.testnet && process.env.MAINNET_ENABLED !== "true") {
  throw new Error(
    `Refusing to start on ${networkConfig.name}: set MAINNET_ENABLED=true to opt in. ` +
      "Real funds are at risk — review MAINNET_MAX_TX_VALUE_WEI and " +
      "MAINNET_MAX_GRANT_EXPIRY_SECONDS before enabling.",
  );
}

export const config = {
  port: Number(process.env.PORT ?? "3000"),
  rpcUrl: requireEnv(networkConfig.rpcUrlEnv),
  walletMnemonic: requireEnv("WALLET_MNEMONIC"),
  walletCount: parseWalletCount(process.env.WALLET_COUNT),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? "120000"),
  databasePath:
    process.env.DATABASE_PATH ??
    (networkConfig.testnet ? "./data/wallets.db" : "./data/mainnet-wallets.db"),
  network: networkConfig.name,
  networkConfig,
  chainId: networkConfig.chainId,
  isTestnet: networkConfig.testnet,
  /** Per-transaction value ceiling. Null on testnets, which are uncapped. */
  maxTxValueWei: networkConfig.testnet
    ? null
    : parseWeiEnv("MAINNET_MAX_TX_VALUE_WEI", DEFAULT_MAINNET_MAX_TX_VALUE_WEI),
  // Longest `expiry` (duration in seconds) a grant request may ask for.
  permissionsMaxExpirySeconds: networkConfig.testnet
    ? Number(
        process.env.PERMISSIONS_MAX_EXPIRY_SECONDS ??
          String(TESTNET_MAX_GRANT_EXPIRY_SECONDS),
      )
    : Number(
        process.env.MAINNET_MAX_GRANT_EXPIRY_SECONDS ??
          String(MAINNET_MAX_GRANT_EXPIRY_SECONDS),
      ),
  permissionsDefaultExpirySeconds: Number(
    process.env.PERMISSIONS_DEFAULT_EXPIRY_SECONDS ?? String(60 * 60),
  ),
  /** Mainnet grants must carry a `spending-cap` unless this is relaxed. */
  allowUnboundedGrants:
    networkConfig.testnet || process.env.MAINNET_ALLOW_UNBOUNDED_GRANTS === "true",
  minWalletCount: MIN_WALLET_COUNT,
  maxWalletCount: MAX_WALLET_COUNT,
};

export const DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0";
