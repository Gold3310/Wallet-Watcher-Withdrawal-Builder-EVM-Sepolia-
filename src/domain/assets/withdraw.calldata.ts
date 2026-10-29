/**
 * Pure calldata construction, for a browser that has a wallet but no ethers.
 *
 * Encoding lives here rather than in the page so it stays typed, tested, and
 * in one place. The page asks this server for the bytes it needs to sign and
 * does no ABI arithmetic of its own — an untested `padStart` in a browser is
 * exactly where a wrong amount would slip through unnoticed.
 *
 * Nothing in here touches a key, a chain, or a network. It turns a number
 * into bytes.
 */
import { getAddress } from "ethers";
import { trackedContractInterface } from "./abi.js";

export const WITHDRAW_SELECTOR = "0x2e1a7d4d";
export const BALANCE_OF_SELECTOR = "0x70a08231";

/** `withdraw(uint256)` — burn ABT, receive ETH. */
export function buildWithdrawCalldata(amountWei: string | bigint): string {
  const amount = normaliseAmount(amountWei);
  return trackedContractInterface.encodeFunctionData("withdraw", [amount]);
}

/** `balanceOf(address)` — the public getter. */
export function buildBalanceOfCalldata(address: string): string {
  return trackedContractInterface.encodeFunctionData("balanceOf", [
    getAddress(address),
  ]);
}

/** Turn an RPC hex word back into a number. */
export function decodeUint256(hex: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`"${String(hex)}" is not a hex quantity`);
  }
  return BigInt(hex);
}

function normaliseAmount(amountWei: string | bigint): bigint {
  let amount: bigint;

  try {
    amount = typeof amountWei === "bigint" ? amountWei : BigInt(amountWei);
  } catch {
    throw new Error(
      `amountWei must be an integer in the token's smallest unit, got "${String(amountWei)}"`,
    );
  }

  if (amount <= 0n) {
    throw new Error("amountWei must be greater than zero");
  }

  return amount;
}
