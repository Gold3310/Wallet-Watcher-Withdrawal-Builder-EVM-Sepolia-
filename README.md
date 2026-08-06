# Wallet Watcher & Withdrawal Builder

A Node.js + TypeScript custody backend slice for **Ethereum Sepolia**. The service derives deterministic HD wallets, tracks native ETH balances, logs balance changes, and builds or broadcasts withdrawal transactions.

## Features

- Deterministic wallet generation (BIP-39 + BIP-44, indices `0..N-1`)
- Balance polling against Sepolia with persisted balances (SQLite)
- Balance-change ledger (inflows from tracking, outflows only on broadcast)
- REST API for wallet balances and withdrawals
- Unit tests for wallet derivation and transaction building

## Wallet derivation (BIP-39 / BIP-44)

Wallets are **not** generated with `Wallet.createRandom()` in a loop. The service uses standard hierarchical deterministic (HD) derivation so the wallet at each index is stable across runs.

| Standard | Role in this project |
|----------|----------------------|
| **BIP-39** | `WALLET_MNEMONIC` in `.env` is the master seed phrase |
| **BIP-32** | Used internally by ethers to derive child keys from that seed |
| **BIP-44** | Ethereum account paths with coin type `60'` |

Derivation path for wallet at index `i`:

```
m/44'/60'/0'/0/{i}
```

Examples:

```
m/44'/60'/0'/0/0   → wallet index 0
m/44'/60'/0'/0/1   → wallet index 1
m/44'/60'/0'/0/2   → wallet index 2
```

This satisfies the assignment's determinism rules:

- Same `N` → same wallet list every run
- `N + m` → original `N` wallets unchanged, plus `m` new ones at higher indices
- `N − m` → subset of the wallets produced for `N`

Implementation: `HDNodeWallet.fromMnemonic()` in `src/domain/wallet/wallet.service.ts`.

## Requirements

- Node.js 20+
- A Sepolia RPC URL (Alchemy, Infura, or public endpoint)
- A testnet-only mnemonic (never use mainnet keys)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at minimum:

- `SEPOLIA_RPC_URL`
- `WALLET_MNEMONIC`

## Run

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Tests:

```bash
npm test
```

## Demo walkthrough (for screenshots)

Run these in order in a separate terminal while `npm run dev` is running.

**1. Start the service**

```bash
npm run dev
```

Screenshot: terminal showing `Initialized 5 wallet(s) on sepolia` and `Server listening on http://localhost:3000`.

![Server startup](docs/screenshots/run-dev.png)

**2. List wallets and balances**

```bash
GET http://localhost:3000/wallets
```

Screenshot: JSON response with wallet addresses and balances (fund wallet index 0 via a Sepolia faucet first if balances are zero).

![Server startup showing 5 wallets initialized on Sepolia](docs/screenshots/get-wallets.png)

**3. Build a withdrawal (no broadcast)**

```bash
curl -X POST http://localhost:3000/withdrawals   -H "Content-Type: application/json"   -d '{
    "fromWalletIndex": 0,
    "toAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "amountWei": "1000000000000000",
    "broadcast": false
  }'
```

Screenshot: response with `"broadcast": false`, `"txHash": null`, and signed `transaction` fields (`serialized`, `hash`, `signature`).

![responses with signed transactions](docs/screenshots/withdrawls.png)

**4. Broadcast a withdrawal (optional)**

Send to one of your own derived wallet addresses from step 2:

```bash
curl -s -X POST http://localhost:3000/withdrawals \
  -H "Content-Type: application/json" \
  -d '{
    "fromWalletIndex": 0,
    "toAddress": "0x2EF4c86Bdd42884339643D2beCB32988D90A46F4",
    "amountWei": "1000000000000000",
    "broadcast": true
  }'
```

Screenshot: response with `"broadcast": true` and a `txHash`. After the next poll, screenshot `GET /wallets` again showing the updated balance.

![broadcast with withdrawls](docs/screenshots/broadcast-with-withdrawls.png)

**5. Run unit tests**

```bash
npm test
```

Screenshot: terminal showing all tests passing (wallet generation + transaction building).

![broadcast with withdrawls](docs/screenshots/test.png)

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SEPOLIA_RPC_URL` | Sepolia JSON-RPC endpoint | required |
| `WALLET_MNEMONIC` | BIP-39 mnemonic for wallet derivation | required |
| `WALLET_COUNT` | Number of wallets to manage (1–20) | `5` |
| `POLL_INTERVAL_MS` | Balance polling interval | `120000` (2 min) |
| `PORT` | HTTP server port | `3000` |
| `DATABASE_PATH` | SQLite database path | `./data/wallets.db` |

## API

### `GET /health`

Health check.

### `GET /wallets`

Returns all configured wallets and their persisted balances.

Example response:

```json
{
  "network": "sepolia",
  "chainId": 11155111,
  "walletCount": 5,
  "wallets": [
    {
      "index": 0,
      "address": "0x...",
      "balanceWei": "1000000000000000",
      "balanceEth": "0.001"
    }
  ]
}
```

### `POST /withdrawals`

Builds a withdrawal from a wallet index to a destination address.

Request body:

```json
{
  "fromWalletIndex": 0,
  "toAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "amountWei": "1000000000000000",
  "broadcast": false
}
```

- `broadcast: false` — returns the signed transaction JSON (payload + signature). No outflow is recorded.
- `broadcast: true` — sends the transaction to Sepolia and records an outflow in the ledger.

Example response (`broadcast: false`):

```json
{
  "network": "sepolia",
  "chainId": 11155111,
  "broadcast": false,
  "txHash": null,
  "transaction": {
    "from": "0x...",
    "to": "0x...",
    "value": "1000000000000000",
    "valueEth": "0.001",
    "chainId": 11155111,
    "nonce": 0,
    "gasLimit": "21000",
    "maxFeePerGas": "...",
    "maxPriorityFeePerGas": "...",
    "hash": "0x...",
    "serialized": "0x02...",
    "signature": {
      "r": "0x...",
      "s": "0x...",
      "v": 27
    }
  }
}
```

## Funding test wallets

After starting the service, copy addresses from `GET /wallets` and fund them using a Sepolia faucet, for example:

- [POW Sepolia Faucet](https://sepolia-faucet.pk910.de/)
- [Google Cloud Sepolia Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)

The balance poller will detect deposits within the configured polling interval (default 2 minutes, well within the 10-minute requirement).

## Deposit handling

This service uses **balance polling**, not per-transaction deposit indexing.

### Multiple deposits within one polling interval

If several deposits arrive between polls, the service only observes the **net on-chain balance** at poll time. It records **one inflow ledger entry** equal to:

```
new_balance - previous_balance
```

Individual deposits within the interval are not separated in the ledger.

### Service offline

If the service is down during incoming deposits, the next successful poll compares the current on-chain balance with the last persisted balance. Any increase is recorded as a **single catch-up inflow** for the total delta. Intermediate balance states while offline are not reconstructed unless tx-level backfill is added.

## Architecture

```
src/
├── config/                 # Environment configuration
├── domain/
│   ├── wallet/             # HD derivation
│   ├── balance/            # Balance sync + wallet views
│   ├── ledger/             # Outflow recording
│   └── withdrawal/         # Tx build/sign/broadcast
├── infra/
│   ├── db/                 # SQLite persistence
│   └── rpc/                # ethers provider
├── api/                    # Express routes
├── jobs/                   # Background balance poller
└── index.ts                # Entry point
```

## Trade-offs

| Decision | Rationale |
|----------|-----------|
| Native ETH on Sepolia | Simplest asset; avoids ERC-20 contract and approval logic |
| SQLite | Zero-setup persistence suitable for a take-home demo |
| Polling (2 min default) | Meets the 10-minute SLA with simpler ops than WebSocket subscriptions |
| Re-derive keys at sign time | Private keys are not stored in the database |
| No deposit aggregation | Out of assignment scope; documented behavior instead |

## Security notes

- Testnet only — do not use real/mainnet mnemonics
- Never commit `.env` or secrets
- Private keys are derived in memory from `WALLET_MNEMONIC` when signing
