import { insertLedgerEntry } from "../../infra/db/database.js";

export function recordOutflow(
  walletId: number,
  amountWei: string,
  txHash: string,
): void {
  insertLedgerEntry(walletId, "outflow", amountWei, txHash);
}
