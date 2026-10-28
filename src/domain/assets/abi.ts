/**
 * The tracked contract's ABI, verbatim from the verified source on Etherscan
 * for 0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea.
 *
 * Why the real ABI matters here instead of a minimal ERC-20 fragment: this is
 * **not** a plain ERC-20. It is a WETH-style wrapper whose `transfer` and
 * `transferFrom` are gated. Reading it as a generic token would report a
 * balance you cannot move, and then fail at the worst moment.
 *
 * Verified against the deployed bytecode:
 *
 * - All 17 function selectors in this ABI are dispatched by the runtime code,
 *   so the interface below is complete — there is no hidden function.
 * - `transfer(address,uint256)` and `transferFrom(address,address,uint256)`
 *   are the only two functions that route through the guarded helper at
 *   runtime offset 0x0c02. That helper reverts with **"Transfer not
 *   permitted"** unless the sender is the `hubPool`, an approved proposer
 *   (`proposers(sender) == true`), or an authorising STATICCALL to the
 *   hubPool (selector 0x4144fd61, 7 words of arguments) approves the move.
 * - `withdraw(uint256)` is a standard WETH unwrap and is **not** gated. It
 *   decrements `balanceOf(msg.sender)`, sends that much ETH to `msg.sender`
 *   and emits `Withdrawal`. This is the only path out of a balance you hold.
 * - `deposit()` is payable and mints, ungated.
 * - `setProposer`, `transferOwnership` and `renounceOwnership` are Ownable;
 *   they revert with "Ownable: caller is not the owner" for anyone else.
 *
 * The `hubPool` is an immutable pinned at construction to
 * 0xc186fA914353c44b2E33eBE05f21846F1048bEda — Across Protocol's Hub Pool V2
 * on Ethereum mainnet. **This is a mainnet contract.** Tracking it on a
 * testnet reports nothing, because the address is an empty account there.
 */
import { Interface, type InterfaceAbi } from "ethers";

export const TRACKED_CONTRACT_ABI: InterfaceAbi = [
  {
    inputs: [
      {
        internalType: "contract ExtendedHubPoolInterface",
        name: "_hubPool",
        type: "address",
      },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "src", type: "address" },
      { indexed: true, internalType: "address", name: "guy", type: "address" },
      { indexed: false, internalType: "uint256", name: "wad", type: "uint256" },
    ],
    name: "Approval",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "dst", type: "address" },
      { indexed: false, internalType: "uint256", name: "wad", type: "uint256" },
    ],
    name: "Deposit",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "previousOwner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "address",
        name: "proposer",
        type: "address",
      },
      { indexed: false, internalType: "bool", name: "enabled", type: "bool" },
    ],
    name: "ProposerModified",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "src", type: "address" },
      { indexed: true, internalType: "address", name: "dst", type: "address" },
      { indexed: false, internalType: "uint256", name: "wad", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "src", type: "address" },
      { indexed: false, internalType: "uint256", name: "wad", type: "uint256" },
    ],
    name: "Withdrawal",
    type: "event",
  },
  { stateMutability: "payable", type: "fallback" },
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "guy", type: "address" },
      { internalType: "uint256", name: "wad", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "deposit",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "hubPool",
    outputs: [
      {
        internalType: "contract ExtendedHubPoolInterface",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "proposers",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "proposer", type: "address" },
      { internalType: "bool", name: "enabled", type: "bool" },
    ],
    name: "setProposer",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "dst", type: "address" },
      { internalType: "uint256", name: "wad", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "src", type: "address" },
      { internalType: "address", name: "dst", type: "address" },
      { internalType: "uint256", name: "amt", type: "uint256" },
    ],
    name: "transferFrom",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "newOwner", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "wad", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { stateMutability: "payable", type: "receive" },
];

/**
 * Superset of ERC-20, so it encodes the standard calls byte-identically while
 * also covering this contract's own `owner()`, `hubPool()`, `proposers()` and
 * `withdraw(uint256)`.
 */
export const trackedContractInterface = new Interface(TRACKED_CONTRACT_ABI);

/**
 * True: `transfer`/`transferFrom` both route through the guarded helper and
 * revert "Transfer not permitted" for unapproved senders. Confirmed against
 * the deployed bytecode, not inferred from the ABI alone.
 *
 * A balance in this contract is therefore NOT spendable by the normal
 * withdrawal path. See `UNWRAP_FUNCTION`.
 */
export const TRANSFERS_RESTRICTED = true;

/**
 * The way out of a restricted balance: `withdraw(uint256)` burns the caller's
 * wrapped balance and sends that much ETH to the caller, ungated. Unwrap
 * first, then move the ETH with an ordinary transfer.
 */
export const UNWRAP_FUNCTION = "withdraw";

/**
 * Immutable pinned at construction. Its value is what identifies this contract
 * as a mainnet deployment of Across' hub-pool-aware WETH.
 */
export const HUB_POOL_IMMUTABLE =
  "0xc186fA914353c44b2E33eBE05f21846F1048bEda";
