import { insertLedgerEntry } from "../../infra/db/database.js";

export function recordOutflow(
  walletId: number,
  amountWei: string,
  txHash: string,
  actor: string | null = null,
): void {
  insertLedgerEntry(walletId, "outflow", amountWei, txHash, actor);
}
