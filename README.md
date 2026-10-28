# Wallet Watcher & Withdrawal Builder

A Node.js + TypeScript custody backend slice for **Ethereum Sepolia**. The service derives deterministic HD wallets, tracks native ETH balances, logs balance changes, and builds or broadcasts withdrawal transactions.

## Features

- Deterministic wallet generation (BIP-39 + BIP-44, indices `0..N-1`)
- Balance polling against Sepolia with persisted balances (SQLite)
- Balance-change ledger (inflows from tracking, outflows only on broadcast)
- REST API for wallet balances and withdrawals
- ERC-7715 session permissions (grant, inspect, revoke, redeem) with expiry and spending policies
- Runs on Sepolia or mainnet, with per-chain guardrails when funds are real
- Unit tests for wallet derivation, transaction building, permissions and network config

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

## Networks

The same code runs against Sepolia or Ethereum mainnet. One mnemonic produces
**the same addresses on both chains**, so balances and the ledger are only
meaningful per chain — the database is pinned to the chain it was created on and
the service refuses to open it on another (`DATABASE_PATH` per chain).

| `CHAIN` | Chain ID | RPC variable | Guardrails |
|---------|----------|--------------|------------|
| `sepolia` (default) | 11155111 | `SEPOLIA_RPC_URL` | none — value uncapped, unbounded grants allowed |
| `mainnet` | 1 | `MAINNET_RPC_URL` | opt-in required, per-transaction cap, 24h grant cap, `spending-cap` mandatory |

### Mainnet guardrails

Mainnet moves real funds, so it is deliberately harder to run than a testnet:

| Rail | Default | Effect |
|------|---------|--------|
| `MAINNET_ENABLED` | unset | The service **refuses to boot** on mainnet unless this is exactly `true` |
| `MAINNET_MAX_TX_VALUE_WEI` | `100000000000000000` (0.1 ETH) | Ceiling on any single transaction, enforced for both `POST /withdrawals` and permission redemptions |
| `MAINNET_MAX_GRANT_EXPIRY_SECONDS` | `86400` (24h) | Longest permission grant accepted on mainnet |
| `MAINNET_ALLOW_UNBOUNDED_GRANTS` | `false` | Grants without a `spending-cap` policy are rejected |
| `DATABASE_PATH` | `./data/mainnet-wallets.db` | Separate store from the testnet database |

On boot the service prints the guardrails in effect:

```
Network: mainnet (chainId 1) — MAINNET
*** MAINNET: real funds are at risk. Guardrails in effect:
***   per-transaction limit:     0.1 ETH
***   max permission grant:      86400s
***   unbounded grants allowed:  false
***   database:                  ./data/mainnet-wallets.db (bound to mainnet)
Initialized 5 wallet(s) on mainnet
```

None of this is a substitute for an approval process, a hardware signer, or a
withdrawal allowlist — see [Security notes](#security-notes).

## Requirements

- Node.js 20+
- An RPC URL for the chain you are running (Alchemy, Infura, or a public endpoint)
- A mnemonic for wallet derivation — use a testnet-only mnemonic unless you
  intend to run against mainnet, and treat it as a production secret if you do

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
| `CHAIN` | `sepolia` or `mainnet` | `sepolia` |
| `SEPOLIA_RPC_URL` | Sepolia JSON-RPC endpoint | required when `CHAIN=sepolia` |
| `MAINNET_RPC_URL` | Mainnet JSON-RPC endpoint | required when `CHAIN=mainnet` |
| `MAINNET_ENABLED` | Opt in to running on mainnet | unset (refuses to boot) |
| `MAINNET_MAX_TX_VALUE_WEI` | Mainnet per-transaction ceiling, in wei | `100000000000000000` (0.1 ETH) |
| `MAINNET_MAX_GRANT_EXPIRY_SECONDS` | Longest mainnet permission grant | `86400` |
| `MAINNET_ALLOW_UNBOUNDED_GRANTS` | Allow mainnet grants without a `spending-cap` | `false` |
| `WALLET_MNEMONIC` | BIP-39 mnemonic for wallet derivation | required |
| `WALLET_COUNT` | Number of wallets to manage (1–20) | `5` |
| `POLL_INTERVAL_MS` | Balance polling interval | `120000` (2 min) |
| `PORT` | HTTP server port | `3000` |
| `DATABASE_PATH` | SQLite database path | `./data/wallets.db` |
| `PERMISSIONS_MAX_EXPIRY_SECONDS` | Longest accepted permission grant | `2592000` (30 days) |
| `PERMISSIONS_DEFAULT_EXPIRY_SECONDS` | Grant expiry when a request omits it | `3600` (1 hour) |

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

## Session permissions (ERC-7715)

Beyond signing every withdrawal with the account key, the service can hand out
**scoped, expiring permissions** using the same shape as the
[`wallet_grantPermissions`](https://www.openfort.io/docs/products/cross-app-wallet/rpc/wallet_grantPermissions)
RPC ([ERC-7715](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7715.md)).

A grant registers a **session signer** on an account together with the
permissions and policies that bound what it may do. The session key is derived
per grant and is what authorises a redemption; the account key is what actually
executes it.

### How it works

| Step | What happens |
|------|--------------|
| Grant | `POST /permissions` builds the `wallet_grantPermissions` request, derives a fresh session key, hashes the permissions, signs the grant digest with the account key, and persists the session |
| Store | Only a random 32-byte seed is persisted. The session key is re-derived as `keccak256(accountKey ‖ seed)`, so a database leak alone yields nothing without the mnemonic |
| Redeem | `POST /permissions/:id/redeem` checks status/expiry/policies, signs the action digest with the re-derived session key, verifies the signature recovers to the granted signer, then builds (and optionally broadcasts) the withdrawal with the account key |

### Deviation from a full smart-account flow

The accounts here are plain EOAs derived from the HD mnemonic, so there is no
on-chain permission validator to redeem against. In a full ERC-7715 setup the
session key signs a UserOperation and a smart account executes it; here the
session key authorises and **this backend** executes, after enforcing the grant
itself. The payloads, hashing and `permissionsContext` are otherwise faithful to
the spec, so the grant can be handed to a wallet that speaks ERC-7715 (for
example the Rapidfire ID sample wallet) unchanged.

### Encoding

Every field is hashed with a fixed layout so both sides can recompute it:

```
selector(signature)  = 4-byte selector, or keccak256(signature)[0:4]
dataHash             = keccak256(abi.encode(address, keccak256(selectors)))
policiesHash         = keccak256(concat(policyHash...))  |  0x00..00 when empty
permissionHash       = keccak256(abi.encode(PERMISSION_TYPEHASH,
                           keccak256(type), dataHash, policiesHash))
permissionsHash      = keccak256(concat(permissionHash...))
grantDigest          = keccak256(abi.encode(GRANT_TYPEHASH, account,
                           signerHash, expiry, permissionsHash))
permissionsContext   = 0x77150001 ++ abi.encode(account, signerHash,
                           expiry, permissionsHash)
```

`0x77150001` is a 4-byte tag — ERC number `7715`, encoding version `1` — so a
verifier can tell this context apart from any other opaque blob. Contexts are
self-describing and can be decoded with `GET /permissions/context/:context`
without trusting a `sessionId`.

### Enforced policies

| Policy | Data | Effect |
|--------|------|--------|
| `spending-cap` | `{ "limit": "<wei>" }` | Cumulative native value the session may move. The strictest cap across all granted permissions wins |
| `value-limit` | `{ "limit": "<wei>" }` | Maximum native value in a single redemption |

Other policy types are hashed into the permission (so they are faithfully
recorded in the grant) but are not enforced by this backend.

Only `native-token-transfer` permissions are executable today. ERC-20 / 721 /
1155 and `contract-call` permissions can be granted — they are hashed, stored and
returned — but redeeming them fails with a clear `400`.

### API

#### `POST /permissions`

Request:

```json
{
  "fromWalletIndex": 0,
  "expiry": 604800,
  "signerType": "key",
  "permissions": [
    {
      "type": "contract-call",
      "data": {
        "address": "0x706aa5c8e5cc2c67da21ee220718f6f6b154e75c",
        "calls": [{ "signature": "transfer(address,uint256)" }]
      },
      "policies": []
    }
  ]
}
```

- `expiry` is a **duration in seconds** (as in the RPC). It is capped by
  `PERMISSIONS_MAX_EXPIRY_SECONDS` and defaults to
  `PERMISSIONS_DEFAULT_EXPIRY_SECONDS`.
- `signerType` is optional (`key` by default) and `permissions` must be
  non-empty.

Response (`201`, abridged — `request.permissions` echoes the body above and
`response.grantedPermissions` echoes that back) carries `request` (what a wallet
would receive), `response` (what it would return — note the absolute `expiry`)
and the stored `session`:

```json
{
  "network": "sepolia",
  "chainId": 11155111,
  "method": "wallet_grantPermissions",
  "request": { "expiry": 604800, "signer": { "type": "key", "data": { "id": "0x..." } }, "permissions": [] },
  "response": {
    "expiry": 1761561600,
    "grantedPermissions": [],
    "permissionsContext": "0x77150001..."
  },
  "session": {
    "id": 1,
    "walletIndex": 0,
    "account": "0x...",
    "status": "active",
    "expiresAt": "2026-10-27T15:00:00.000Z",
    "remainingSeconds": 604800,
    "spentWei": "0",
    "remainingWei": null,
    "nonce": 0
  }
}
```

#### `GET /permissions`

Optional `?walletIndex=N` filter. Returns every session with a derived `status`
of `active`, `expired` or `revoked`.

#### `GET /permissions/:id`

A single session.

#### `GET /permissions/context/:context`

Decodes a `permissionsContext` and reports whether it is `known` and `intact`
(its embedded `permissionsHash` matches the stored grant).

#### `POST /permissions/:id/revoke`

Revokes a session. Revocation is terminal; later redemptions fail.

#### `POST /permissions/:id/redeem`

```json
{
  "toAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "amountWei": "10000000000000000",
  "broadcast": true
}
```

Checks the session, the permission type and the policies, then signs the action
digest with the session key and builds the transfer with the account key.

Same headers as `POST /withdrawals`: `Authorization` when tokens are configured,
and `Idempotency-Key` whenever `broadcast: true`.

- `broadcast: false` (`200`) — authorisation only. Nothing is sent, and neither
  the spending cap nor the action nonce is consumed.
- `broadcast: true` (`201`) — sends the transaction, records the outflow ledger
  entry, adds the amount to `spentWei` and increments the nonce.

```json
{
  "broadcast": true,
  "txHash": "0x...",
  "authorization": {
    "actionDigest": "0x...",
    "nonce": 0,
    "sessionKeySignature": "0x...",
    "recoveredSigner": "0x..."
  },
  "transaction": { "...": "same shape as POST /withdrawals" },
  "session": { "nonce": 1, "spentWei": "10000000000000000", "remainingWei": "40000000000000000" }
}
```

### Demo walkthrough

```bash
# 1. Grant a session key that may move up to 0.05 ETH for a week
curl -s -X POST http://localhost:3000/permissions \
  -H "Content-Type: application/json" \
  -d '{
    "fromWalletIndex": 0,
    "expiry": 604800,
    "permissions": [{
      "type": "native-token-transfer",
      "data": {},
      "policies": [{ "type": "spending-cap", "data": { "limit": "50000000000000000" } }]
    }]
  }'

# 2. Redeem 0.01 ETH with that session key (no broadcast)
curl -s -X POST http://localhost:3000/permissions/1/redeem \
  -H "Content-Type: application/json" \
  -d '{"toAddress":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","amountWei":"10000000000000000","broadcast":false}'

# 3. Inspect the remaining allowance
curl -s http://localhost:3000/permissions/1

# 4. Revoke it
curl -s -X POST http://localhost:3000/permissions/1/revoke
```

## Withdrawable owner

Withdrawals can be restricted to a fixed set of destinations via
`WITHDRAWAL_ALLOWLIST`. The address configured in `.env.example` is the
**withdrawable owner** — the destination this service is allowed to send funds
to:

```
0x2ddFBecA5B62f310A5F8edEFB4fC026A99B979CE
```

With the allowlist set, `POST /withdrawals` and `POST /permissions/:id/redeem`
to any **other** address are rejected with `400` before anything is signed.
Leave `WITHDRAWAL_ALLOWLIST` empty to allow any destination (the default when
the variable is unset).

Copy it into your `.env` to activate it:

```bash
cp .env.example .env   # then edit WALLET_MNEMONIC and the RPC url
```

Addresses are normalised to EIP-55 checksum form, so lowercase input matches.

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
│   ├── permissions/        # ERC-7715 grant/redeem + encoding
│   └── withdrawal/         # Tx build/sign/broadcast
├── infra/
│   ├── db/                 # SQLite persistence
│   └── rpc/                # ethers provider
├── api/                    # Express routes (wallets, withdrawals, permissions)
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
| Session key = KDF(account key, stored seed) | Session keys are re-derivable but a database leak alone is useless without the mnemonic |
| Only `native-token-transfer` is redeemable | No ERC-20 validator or allowance plumbing on the EOA custody path |
| Broadcast redemptions consume the cap | Build-only redemptions stay side-effect free |
| No deposit aggregation | Out of assignment scope; documented behavior instead |
| Mainnet guardrails instead of a policy engine | Bounds blast radius without pretending to be an approval workflow |
| Database pinned to one chain | Addresses repeat across chains; mixing ledgers would silently corrupt balances |

## Security notes

- Default to Sepolia. Mainnet is opt-in per boot, not per request, and only
  with `MAINNET_ENABLED=true`
- The guardrails here are a speed limit, not a policy engine: they bound how
  much a single transaction or session can move, but anyone who can reach the
  API can still spend up to that bound. For real custody add authentication,
  an approval step, an address allowlist and a hardware-backed signer
- Do not reuse a testnet mnemonic on mainnet, and treat a mainnet mnemonic as a
  production secret — every derived key is reachable from it
- Never commit `.env` or secrets
- Private keys are derived in memory from `WALLET_MNEMONIC` when signing
- Permission sessions are enforced by this service, not by an on-chain
  validator: revoking is a database flag, and policy checks happen at redemption
  time. Treat the database as part of the trust boundary
- `spending-cap` and `value-limit` bound **native** value only; they do not
  constrain ERC-20 `transfer` amounts, which this backend does not execute
