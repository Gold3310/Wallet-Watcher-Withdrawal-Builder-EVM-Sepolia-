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

## Withdrawing from a specific holder

`withdraw(uint256)` burns the **caller's own** balance. Nobody can redeem
someone else's ABT — not this service, not the contract owner, not a relayer.
So plan the withdrawal for a named address and find out first:

```bash
npm run withdraw:plan -- --from 0xf7bAc63f… --amount 7.485 --chain-id 1
POST /assets/withdraw/plan   { "from": "0x…", "amountWei": "7485000000000000000" }
```

Nothing is signed and nothing is broadcast. It answers one question — *can this
service sign for that address?* — and then either routes you to
`POST /assets/unwrap` or hands you a signing kit for the holder.

### `0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c` (7.485 ABT)

```
from:          0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c
amount:        7.485 ABT (7485000000000000000 units)
balance:       7.485
sufficient:    yes
can sign here: NO
route:         external

TRANSACTION (unsigned)
  to:    0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea
  data:  0x2e1a7d4d00000000000000000000000000000000000000000000000067e00fd7bfcc8000
  value: 0
  chain: 1
```

The balance covers it. **The signature does not exist here.** That address is
not derived from `WALLET_MNEMONIC`, so there is no key for it in this project,
and `withdraw()` will revert for anyone who is not that address regardless of
what they hold or who they are.

Only the holder of `0xf7bAc63f…` can redeem those 7.485 ABT, by signing that
transaction in whatever wallet controls the address. Gas comes from the same
address, so it needs ETH for gas separately from the ABT being burned.

**This service will not accept a private key to get around that.** If the key
is not derivable from `WALLET_MNEMONIC`, there is no path here, and pretending
otherwise would be worse than saying so.

If you do hold that key, sign the transaction above in MetaMask, a Ledger, or
your own script — you do not need this project to do it.

## Finding every holder

The contract cannot enumerate its holders — `balanceOf` is a mapping, and you
need a key before it will answer. But the accounts are recoverable from logs,
and once you have them the contract tells you exactly what each holds today.

**Enumerate from logs, then read balances live.** Not one or the other.

```bash
npm run holders:scan -- --from-block <deploymentBlock>   # live
npm run holders:scan -- --offline                        # recorded history
```

Against the recorded history:

```
candidates: 4 address(es) ever received ABT
holders:    4 with a non-zero balance now
supply:     42.591

  0x54f44eA3…   34.505   81.0148%
  0xf7bAc63f…    7.485   17.5741%
  0xc186fA91…     0.45    1.0566%
  0x9A8f92a8…     0.151    0.3545%
```

### Three corrections worth recording

**1. `balanceOf` *is* public.** It is in the ABI as
`function balanceOf(address) view returns (uint256)` — Solidity generates a
getter for `public` mappings, and this project calls it on every run. What the
contract cannot do is *list* holders, which is a different thing. The practical
consequence matters: you do not need to reconstruct balances from logs. Logs
give you *addresses*; `balanceOf` gives you *current* amounts. A log-derived
balance goes stale the moment anyone moves.

**2. `deposit()` emits `Deposit(dst, wad)` and no `Transfer`.** Scanning
`Transfer` alone silently misses everyone who got ABT by wrapping ETH rather
than receiving it. This scanner reads both events.

**3. The snippet circulating is ethers v5.** This repo is **ethers v6**
(`^6.13.5`). `ethers.providers.JsonRpcProvider` and `ethers.utils.formatEther`
do not exist here; both are top-level imports now.

### ethers v6, as this repo uses it

```javascript
import { JsonRpcProvider, Contract, formatEther, parseUnits } from "ethers";

const ABT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const provider = new JsonRpcProvider(process.env.MAINNET_RPC_URL);
const signer = await provider.getSigner(); // the wallet holding ABT

const abt = new Contract(ABT, [
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(uint256)",
], signer);

const balance = await abt.balanceOf(await signer.getAddress());
if (balance === 0n) {
  console.log("No ABT to withdraw");
} else {
  // Name the amount. Do not sweep: an explicit amount is auditable, and a
  // sweep can fail on gas estimation with no balance left to retry with.
  const wad = parseUnits("1", 18);
  const tx = await abt.withdraw(wad);
  await tx.wait();
  console.log(`Withdrawn ${formatEther(wad)} ETH`);
}
```

`withdraw` is **not** payable — you send no value; the contract sends ETH to
you. Gas still comes from the caller.

### One open question, flagged rather than asserted

The hubPool transfer gate is documented here as living inside `transferFrom`
(`if (dst == address(hubPool))`, requiring `proposers[src]` or that you are not
the current bundle proposer). If `transfer` is **not** separately overridden,
then plain `transfer(hubPool, wad)` would bypass that check entirely.

That is a claim about the verified source, not something confirmed by a call —
this sandbox has no chain access. Treat it as unverified until someone runs a
`balanceOf`/`transfer` trace on mainnet.

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
