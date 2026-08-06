// Test-only defaults. Do not load the project .env here — unit tests must
// stay isolated from your local wallet configuration.
process.env.SEPOLIA_RPC_URL ??=
  "https://ethereum-sepolia-rpc.publicnode.com";
process.env.WALLET_MNEMONIC ??=
  "test test test test test test test test test test test junk";
process.env.WALLET_COUNT ??= "5";
process.env.DATABASE_PATH ??= ":memory:";
