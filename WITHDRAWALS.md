# Withdrawals — every function, in one place

Contract: `0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea` (Across `BondToken`, ABT)

Everything in this document is also available from the code, so it can never
drift from what is actually deployed:

```bash
npm run withdrawals            # print the whole catalogue, offline
npm run withdrawals -- --id contract:withdraw
npm run withdrawals -- --json
curl http://localhost:3000/assets/withdrawals
curl http://localhost:3000/assets/withdrawals/contract:withdraw
```

13 capabilities: 8 on the contract, 2 HTTP routes, 3 commands.
10 are available from here; 3 are blocked, and blocked on a key that is not in
this repository.

---

## The one sentence

**`withdraw(uint256)` is the only route to the contract's 42.591 ETH.** It is
ungated — no owner approval, no proposer rights — and it needs exactly one
thing: an ABT balance at an address you can sign for.

Everything administrative is `onlyOwner`, and the owner is the Risk Labs
deployer `0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D`, which is not a wallet
this service has keys for. See [Can you become the owner?](#can-you-become-the-owner).

---

## Quick reference

| Capability | Kind | Selector | Needs | Runs here |
|---|---|---|---|---|
| `contract:withdraw` | redeem | `0x2e1a7d4d` | an ABT balance | **yes** |
| `contract:transfer` | transfer | `0xa9059cbb` | ABT + allowlisted destination | yes |
| `contract:transferFrom` | transfer | `0x23b872dd` | a prior `approve` | yes |
| `contract:deposit` | wrap | `0xd0e30db0` | ETH | yes |
| `contract:approve` | approve | `0x095ea7b3` | a wallet | yes |
| `contract:setProposer` | admin | `0xe9ed9b64` | the owner role | **no** |
| `contract:transferOwnership` | admin | `0xf2fde38b` | the owner role | **no** |
| `contract:renounceOwnership` | admin | `0x715018a6` | the owner role | **no** |
| `api:assets:unwrap` | redeem | — | API token + ABT balance at that index | **yes** |
| `api:withdrawals:create` | service | — | API token, ETH, allowlisted destination | **yes** |
| `cli:withdrawals` | inspect | — | nothing | yes |
| `cli:addresses:confirm` | inspect | — | nothing (offline) | yes |
| `cli:wallet:derive` | inspect | — | nothing | yes |

---

## 1. `withdraw(uint256 wad)` — the redemption

**Selector `0x2e1a7d4d`. Ungated.**

Burns ABT 1:1 and sends you ETH from the contract's reserve. This is the only
function that reaches the 42.591 ETH.

Requires: an ABT balance at an address you can sign for.

```bash
# Build only — inspect the calldata before anything is broadcast
curl -X POST http://localhost:3000/assets/unwrap \
  -H 'x-api-token: <token>' -H 'content-type: application/json' \
  -d '{"fromWalletIndex":0,"amountWei":"1000000000000000000","broadcast":false}'

# Then, to send it
curl -X POST http://localhost:3000/assets/unwrap \
  -H 'x-api-token: <token>' -H 'content-type: application/json' \
  -d '{"fromWalletIndex":0,"amountWei":"1000000000000000000","broadcast":true}'
```

`broadcast: false` returns the built transaction without sending it. Use it.

## 2. `transfer(address dst, uint256 wad)`

**Selector `0xa9059cbb`.**

Sends ABT to any address. Unrestricted everywhere **except** the hubPool
`0xc186fA914353c44b2E33eBE05f21846F1048bEda` — transfers there require proposer
approval, or that you are not the current root-bundle proposer.

No HTTP route exposes this yet; calldata is `0xa9059cbb` + 32-byte destination
+ 32-byte amount, signed from a wallet holding ABT.

## 3. `transferFrom(address src, address dst, uint256 wad)`

**Selector `0x23b872dd`.** Same destination check as `transfer`, plus an
allowance from the token holder.

## 4. `deposit()`

**Selector `0xd0e30db0`.** Payable, no arguments. Wraps ETH into ABT at 1:1 —
value going *in*, not out.

## 5. `approve(address guy, uint256 wad)`

**Selector `0x095ea7b3`.** Grants another address the right to move your ABT.

## 6-8. The administrative functions

`setProposer` (`0xe9ed9b64`), `transferOwnership` (`0xf2fde38b`),
`renounceOwnership` (`0x715018a6`) — all `onlyOwner`. **None of them moves
value.** Holding the role would give you the right to administer the token, not
a claim on its reserve.

---

## Service routes

### `POST /assets/unwrap`

Builds `withdraw(uint256)` for a derived wallet: burn ABT, take ETH.

```json
{ "fromWalletIndex": 0, "amountWei": "1000000000000000000", "broadcast": false }
```

Requires an API token for the owner and an ABT balance on that wallet index.

### `POST /withdrawals`

Builds a plain ETH transfer from a derived wallet to an allowlisted address.
**This spends ETH you already hold — it does not touch ABT.**

```json
{ "fromWalletIndex": 0, "toAddress": "0x…", "amountWei": "1000000000000000", "broadcast": false }
```

Requires an API token, ETH on that wallet, and a destination in
`WITHDRAWAL_ALLOWLIST`.

---

## Commands

```bash
npm run withdrawals                    # this catalogue, offline
npm run withdrawals -- --id contract:withdraw
npm run addresses:confirm -- --offline # who holds what, and what is blocked
npm run wallet:derive -- 0             # the address to send tokens to
```

---

## Can you become the owner?

Two questions, because they fail for unrelated reasons. Both are answered live
by `GET /assets/ownership`.

**Can the role be moved to you?** `transferOwnership` is `onlyOwner`, so it must
be signed by the current owner. That is the Risk Labs deployer, which is not a
wallet this service has keys for. No code path produces that signature.

**Would holding it help?** No. Every owner-gated function is administrative and
none moves value; the functions that do move value are ungated and answer to
whoever holds a balance.

> Being made owner would give you a role, not a claim.

---

## What blocks the reserve

The 42.591 ETH is redemption backing for ABT held by others: UMA Store
`0x54f44eA3…` (81.0148%), `0xf7bAc63f…` (17.5741%), and the HubPool V2
`0xc186fA91…` (1.0566%). 100% of supply sits at addresses this service cannot
sign for.

`withdraw()` requires a balance to burn. The ETH is reachable only by holding
the token, and the token can only arrive by transfer from an existing holder.

The holder watcher flags exactly that event: `arrived` — ABT landing at an
address you control. See `GET /assets/holder-activity`.
