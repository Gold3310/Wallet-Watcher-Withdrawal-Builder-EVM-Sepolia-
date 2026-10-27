import dotenv from "dotenv";

dotenv.config();

const MIN_WALLET_COUNT = 1;
const MAX_WALLET_COUNT = 20;

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

export const config = {
  port: Number(process.env.PORT ?? "3000"),
  sepoliaRpcUrl: requireEnv("SEPOLIA_RPC_URL"),
  walletMnemonic: requireEnv("WALLET_MNEMONIC"),
  walletCount: parseWalletCount(process.env.WALLET_COUNT),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? "120000"),
  databasePath: process.env.DATABASE_PATH ?? "./data/wallets.db",
  // Longest `expiry` (duration in seconds) a grant request may ask for.
  permissionsMaxExpirySeconds: Number(
    process.env.PERMISSIONS_MAX_EXPIRY_SECONDS ?? String(30 * 24 * 60 * 60),
  ),
  permissionsDefaultExpirySeconds: Number(
    process.env.PERMISSIONS_DEFAULT_EXPIRY_SECONDS ?? String(60 * 60),
  ),
  chainId: 11155111,
  network: "sepolia" as const,
  minWalletCount: MIN_WALLET_COUNT,
  maxWalletCount: MAX_WALLET_COUNT,
};

export const DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0";
