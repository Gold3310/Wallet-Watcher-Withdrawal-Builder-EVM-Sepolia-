/**
 * The tracked contract's ABI and source, verified on Etherscan for
 * 0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea.
 *
 * It is Across Protocol's **BondToken** ("Across Bond Token", ABT) — WETH9 with
 * an Ownable proposer allowlist bolted on. Solidity 0.8.18, viaIR, optimiser at
 * 1,000,000 runs. `hubPool` is an immutable pinned at construction to
 * 0xc186fA914353c44b2E33eBE05f21846F1048bEda — Across' Hub Pool V2 on Ethereum
 * mainnet — so this is a mainnet contract.
 *
 * THE PART THAT IS EASY TO GET WRONG. BondToken overrides exactly one function:
 *
 *     function transferFrom(address src, address dst, uint256 amt)
 *         public override returns (bool)
 *     {
 *         if (dst == address(hubPool)) {
 *             require(
 *                 proposers[src] || hubPool.rootBundleProposal().proposer != src,
 *                 "Transfer not permitted"
 *             );
 *         }
 *         return super.transferFrom(src, dst, amt);
 *     }
 *
 * The gate is **destination-scoped**, not sender-scoped. A holder can transfer
 * to any address except the hubPool with no permission whatsoever. Sending to
 * the hubPool is blocked only while you are the current pending root-bundle
 * proposer and not an approved proposer — that is the bond-staking path, not
 * ordinary use.
 *
 * So there are two ways out of a balance, not one:
 *
 *   1. `transfer` it to any ordinary address, or
 *   2. `withdraw(uint256)` it — ungated WETH9 unwrap, burns ABT and sends that
 *      much ETH to the caller.
 *
 * Cross-checked against the deployed bytecode: transfer() and transferFrom()
 * are the only functions routed through the guarded helper at 0x0c02, and the
 * only external call they make is a STATICCALL of 224 bytes to the hubPool with
 * selector 0x4144fd61 — which is `rootBundleProposal()`, returning the
 * 7-word RootBundle struct whose `proposer` field the require() tests.
 *
 * ABT is ETH-backed: `totalSupply()` returns `address(this).balance`, and the
 * only way in or out is `deposit()` / `withdraw()`. One ABT is redeemable for
 * one wei of ETH provided the contract holds it.
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
 * The gate is destination-scoped: only transfers *to the hubPool* are checked.
 * Transfers to every other address are unrestricted.
 */
export const TRANSFER_RESTRICTION =
  "Transfers to any address are unrestricted, except to the hubPool: sending " +
  "there requires proposer approval, or that you are not the current " +
  "root-bundle proposer.";

/**
 * Ungated in the base WETH9 implementation: burns the caller's ABT and sends
 * that much ETH to the caller. One of two ways to move a balance, the other
 * being an ordinary transfer to any non-hubPool address.
 */
export const UNWRAP_FUNCTION = "withdraw";

/**
 * Immutable pinned at construction. Its value is what identifies this contract
 * as a mainnet deployment of Across' BondToken.
 */
export const HUB_POOL_IMMUTABLE =
  "0xc186fA914353c44b2E33eBE05f21846F1048bEda";

/**
 * The deployer, from Etherscan. Under OpenZeppelin's Ownable the constructor
 * runs `_transferOwnership(_msgSender())`, so **the deployer is the initial
 * owner** — until and unless `transferOwnership` moved it elsewhere.
 *
 * Two consequences worth keeping in view:
 *
 * - `owner()` has to be read from chain to know who holds the role now. This
 *   address is only where it started. Reporting compares the configured
 *   `OWNER_ADDRESS` against the live `owner()` rather than against this.
 * - Even if the configured owner did hold the role, it would grant nothing
 *   toward moving value. Ownable exposes `setProposer`, `transferOwnership`
 *   and `renounceOwnership`; there is no owner-withdraw function, and
 *   `setProposer` only affects transfers to the hubPool.
 */
export const CONTRACT_CREATOR =
  "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D";

/**
 * The addresses that actually hold the tracked token, from Etherscan's holder
 * list as read on 2026-10-28. Recorded because "who holds it" is the question
 * that decides whether any of the contract's ETH is reachable, and these are
 * the addresses that answer it.
 *
 * The figures below are the observed snapshot, useful for sanity-checking a
 * live read — the report re-reads the balances, it does not trust these:
 *
 *   0x54f44eA3…  UMA Store                    34.5050  (81.01%)
 *   0xf7bAc63f…  unnamed                       7.4850  (17.57%)
 *   0xc186fA91…  Across Protocol HubPool V2    0.4500  ( 1.06%)
 *   0x9A8f92a8…  Risk Labs Deployer              dust
 *
 * Two things follow, and both are worth stating in code rather than in chat:
 *
 * - The contract holds none of its own token. It is the ledger that records
 *   these balances, not a holder of them.
 * - None of these addresses is this service's owner, and none is a wallet it
 *   can sign for. The supply sits entirely outside this service's control, so
 *   the ETH reserve behind it is not redeemable from here at any point.
 */
export const KNOWN_TOKEN_HOLDERS: { label: string; address: string }[] = [
  {
    label: "UMA Store (largest holder)",
    address: "0x54f44eA3D2e7aA0ac089c4d8F7C93C27844057BF",
  },
  {
    label: "second-largest holder",
    address: "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c",
  },
  {
    label: "Across Protocol HubPool V2 (also the restricted destination)",
    address: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
  },
];

/**
 * Just the one function BondToken calls on the hubPool, enough to decode the
 * RootBundle struct and read `proposer` out of it. 7 words = 224 bytes, which
 * matches the staticcall in the bytecode exactly.
 */
export const HUB_POOL_ABI = [
  "function rootBundleProposal() view returns (tuple(bytes32 poolRebalanceRoot, bytes32 relayerRefundRoot, bytes32 slowRelayRoot, uint256 claimedBitMap, address proposer, uint8 unclaimedPoolRebalanceLeafCount, uint32 challengePeriodEndTimestamp))",
] as const;

export const hubPoolInterface = new Interface(
  HUB_POOL_ABI as unknown as string[],
);
