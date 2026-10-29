import { getAddress, isAddress, isHexString } from "ethers";
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

/**
 * `API_TOKENS="<ownerAddress>:<secret>,…"`.
 *
 * The id is the owner address the token acts for, so every withdrawal is
 * attributable to an on-chain identity rather than an arbitrary label. Ids are
 * validated as addresses and stored in EIP-55 checksum form.
 */
function parseApiTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  if (!raw || !raw.trim()) {
    return tokens;
  }

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error(
        `API_TOKENS entries must be "<ownerAddress>:<secret>" (got: ${trimmed})`,
      );
    }

    const id = trimmed.slice(0, separator).trim();

    if (!isAddress(id)) {
      throw new Error(
        `API_TOKENS id must be a valid Ethereum address, got: ${id}`,
      );
    }

    const owner = getAddress(id);

    if (tokens.has(owner)) {
      throw new Error(`Duplicate API token owner: ${owner}`);
    }

    tokens.set(owner, trimmed.slice(separator + 1).trim());
  }

  return tokens;
}

function parseAddressList(raw: string | undefined, name: string): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!isAddress(entry)) {
        throw new Error(`Invalid address in ${name}: ${entry}`);
      }
      return getAddress(entry);
    });
}

/**
 * `OWNER_ADDRESS` — the one address permitted to act.
 *
 * When set, this is not advisory: startup refuses to continue unless
 * `API_TOKENS` contains exactly one entry and it is this address, and every
 * request is checked against it. That makes "only this owner" a property of
 * the running process rather than a convention in a config file.
 */
function parseSoleOwner(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  const value = raw.trim();

  if (!isAddress(value)) {
    throw new Error(
      `OWNER_ADDRESS must be a valid Ethereum address, got: ${value}`,
    );
  }

  return getAddress(value);
}

/**
 * Contracts this service reports on in `GET /assets`.
 *
 * Contract addresses are chain-specific: an address that holds a token on
 * Sepolia is usually an empty account on mainnet. So a per-network override
 * (`MAINNET_TRACKED_CONTRACT` / `SEPOLIA_TRACKED_CONTRACT`) wins over the
 * chain-agnostic `TRACKED_CONTRACT`, which wins over the deprecated
 * `TRACKED_TOKENS` alias. The alias warns rather than being ignored — a
 * configured value that silently stops applying is how a deployment ends up
 * reporting on nothing at all.
 */
function parseTrackedContracts(network: NetworkName): string[] {
  const overrideName =
    network === "mainnet"
      ? "MAINNET_TRACKED_CONTRACT"
      : "SEPOLIA_TRACKED_CONTRACT";
  const override = process.env[overrideName];
  const primary = process.env.TRACKED_CONTRACT;
  const legacy = process.env.TRACKED_TOKENS;

  if (!primary && legacy && legacy.trim()) {
    console.warn(
      "TRACKED_TOKENS is deprecated and will be removed — rename it to TRACKED_CONTRACT.",
    );
  }

  const selected = override ?? primary ?? legacy;
  const name = override
    ? overrideName
    : primary
      ? "TRACKED_CONTRACT"
      : "TRACKED_TOKENS";

  return [...new Set(parseAddressList(selected, name))];
}

function parseOptionalWei(name: string, raw: string | undefined): bigint | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  return parseWeiEnv(name, 1n);
}

/**
 * Optional address setting. An empty value is null rather than a placeholder,
 * because a plausible-looking wrong address is worse than an honest gap —
 * nothing in the ERC-7715 path should send anyone to a contract that was
 * never deployed.
 */
function parseOptionalAddress(
  name: string,
  raw: string | undefined,
): `0x${string}` | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  try {
    return getAddress(raw.trim()) as `0x${string}`;
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

/** Optional hex blob setting, validated so a typo fails at boot. */
function parseOptionalHex(
  name: string,
  raw: string | undefined,
): `0x${string}` | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const value = raw.trim();
  if (!isHexString(value)) {
    throw new Error(`${name} must be hex data: ${raw}`);
  }
  return value as `0x${string}`;
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
  /** Bearer tokens. Empty means the API runs unauthenticated (dev only). */
  apiTokens: parseApiTokens(process.env.API_TOKENS),
  /** Destinations withdrawals may target. Empty means unrestricted. */
  withdrawalAllowlist: parseAddressList(
    process.env.WITHDRAWAL_ALLOWLIST,
    "WITHDRAWAL_ALLOWLIST",
  ),
  /** The sole address permitted to act. Null means any configured token may. */
  ownerAddress: parseSoleOwner(process.env.OWNER_ADDRESS),
  /** Contracts to report balances for in GET /assets. */
  trackedContracts: parseTrackedContracts(networkConfig.name),
  /** Optional per-transaction ceiling on any network. */
  withdrawalMaxValueWei: parseOptionalWei(
    "WITHDRAWAL_MAX_VALUE_WEI",
    process.env.WITHDRAWAL_MAX_VALUE_WEI,
  ),
  /** Velocity limit: max outflow per wallet per window. Null disables it. */
  withdrawalMaxPerWindowWei: parseOptionalWei(
    "WITHDRAWAL_MAX_PER_WINDOW_WEI",
    process.env.WITHDRAWAL_MAX_PER_WINDOW_WEI,
  ),
  withdrawalWindowSeconds: Number(process.env.WITHDRAWAL_WINDOW_SECONDS ?? "86400"),
  /**
   * ERC-7710 delegation manager that permission redemption goes through.
   * Null until configured: the spec response reports it as null with a warning
   * rather than inventing an address.
   */
  permissionsDelegationManager: parseOptionalAddress(
    "PERMISSIONS_DELEGATION_MANAGER",
    process.env.PERMISSIONS_DELEGATION_MANAGER,
  ),
  /** Factory for accounts that must exist before a permission can be redeemed. */
  permissionsAccountFactory: parseOptionalAddress(
    "PERMISSIONS_ACCOUNT_FACTORY",
    process.env.PERMISSIONS_ACCOUNT_FACTORY,
  ),
  /** Calldata for that factory, required whenever the factory is set. */
  permissionsAccountFactoryData: parseOptionalHex(
    "PERMISSIONS_ACCOUNT_FACTORY_DATA",
    process.env.PERMISSIONS_ACCOUNT_FACTORY_DATA,
  ),
  minWalletCount: MIN_WALLET_COUNT,
  maxWalletCount: MAX_WALLET_COUNT,
};

// Derived flags and cross-checks that need the assembled config.

// ERC-7715: an entry in `dependencies` is only meaningful with both halves.
// Half a pair would send a redeemer to deploy an account with no calldata.
if (
  (config.permissionsAccountFactory === null) !==
  (config.permissionsAccountFactoryData === null)
) {
  throw new Error(
    "PERMISSIONS_ACCOUNT_FACTORY and PERMISSIONS_ACCOUNT_FACTORY_DATA must be " +
      "set together, or neither: an ERC-4337 dependency needs both a factory " +
      "and the calldata to call it with.",
  );
}

if (!config.isTestnet && config.apiTokens.size === 0) {
  throw new Error(
    "Refusing to start on mainnet without API_TOKENS: set at least one " +
      '"<ownerAddress>:<secret>" pair so withdrawals are attributable.',
  );
}

// Sole-owner mode is enforced, not documented: if OWNER_ADDRESS is set, the
// configured credentials must resolve to exactly that one address.
if (config.ownerAddress) {
  const owners = [...config.apiTokens.keys()];

  if (owners.length === 0) {
    throw new Error(
      `OWNER_ADDRESS is set to ${config.ownerAddress} but API_TOKENS is empty. ` +
        `Set API_TOKENS="${config.ownerAddress}:<secret>" for exactly that address.`,
    );
  }

  if (owners.length > 1) {
    throw new Error(
      `OWNER_ADDRESS permits exactly one owner, but ${owners.length} are configured ` +
        `(${owners.join(", ")}). Remove every entry except ${config.ownerAddress}.`,
    );
  }

  if (owners[0] !== config.ownerAddress) {
    throw new Error(
      `API_TOKENS owner ${owners[0]} does not match OWNER_ADDRESS ${config.ownerAddress}.`,
    );
  }
}

// A contract address is only meaningful on one chain. Reporting on mainnet
// using an address copied from a testnet silently returns empty balances, so
// say so rather than leaving the operator to wonder.
if (
  !config.isTestnet &&
  config.trackedContracts.length > 0 &&
  !process.env.MAINNET_TRACKED_CONTRACT
) {
  console.warn(
    `Tracking ${config.trackedContracts.join(", ")} on mainnet from ` +
      "TRACKED_CONTRACT. Confirm that address exists on mainnet, or set " +
      "MAINNET_TRACKED_CONTRACT if the two chains use different deployments.",
  );
}

if (!Number.isInteger(config.withdrawalWindowSeconds) || config.withdrawalWindowSeconds <= 0) {
  throw new Error("WITHDRAWAL_WINDOW_SECONDS must be a positive integer");
}

export const apiAuthRequired = config.apiTokens.size > 0;

export { DERIVATION_PATH_PREFIX } from "../domain/wallet/derivation.js";
