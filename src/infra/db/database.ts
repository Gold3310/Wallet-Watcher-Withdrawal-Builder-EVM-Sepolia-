import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config/index.js";

export type LedgerType = "inflow" | "outflow";

export interface WalletRow {
  id: number;
  index: number;
  address: string;
  balance_wei: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id: number;
  wallet_id: number;
  type: LedgerType;
  amount_wei: string;
  tx_hash: string | null;
  created_at: string;
}

let db: Database.Database | null = null;

function ensureDatabaseDirectory(databasePath: string): void {
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true });
}

export function getDatabase(): Database.Database {
  if (!db) {
    ensureDatabaseDirectory(config.databasePath);
    db = new Database(config.databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeSchema(db);
  }
  return db;
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      index_num INTEGER NOT NULL UNIQUE,
      address TEXT NOT NULL UNIQUE,
      balance_wei TEXT NOT NULL DEFAULT '0',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('inflow', 'outflow')),
      amount_wei TEXT NOT NULL,
      tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (wallet_id) REFERENCES wallets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_wallet_id ON ledger(wallet_id);
  `);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function upsertWallet(
  index: number,
  address: string,
): WalletRow {
  const database = getDatabase();
  database
    .prepare(
      `
      INSERT INTO wallets (index_num, address)
      VALUES (?, ?)
      ON CONFLICT(index_num) DO UPDATE SET address = excluded.address
    `,
    )
    .run(index, address);

  return getWalletByIndex(index)!;
}

export function getWalletByIndex(index: number): WalletRow | undefined {
  return getDatabase()
    .prepare(
      `
      SELECT
        id,
        index_num AS "index",
        address,
        balance_wei,
        created_at,
        updated_at
      FROM wallets
      WHERE index_num = ?
    `,
    )
    .get(index) as WalletRow | undefined;
}

export function getAllWallets(): WalletRow[] {
  return getDatabase()
    .prepare(
      `
      SELECT
        id,
        index_num AS "index",
        address,
        balance_wei,
        created_at,
        updated_at
      FROM wallets
      ORDER BY index_num ASC
    `,
    )
    .all() as WalletRow[];
}

export function updateWalletBalance(
  walletId: number,
  balanceWei: string,
): void {
  getDatabase()
    .prepare(
      `
      UPDATE wallets
      SET balance_wei = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
    )
    .run(balanceWei, walletId);
}

export function insertLedgerEntry(
  walletId: number,
  type: LedgerType,
  amountWei: string,
  txHash: string | null = null,
): LedgerRow {
  const result = getDatabase()
    .prepare(
      `
      INSERT INTO ledger (wallet_id, type, amount_wei, tx_hash)
      VALUES (?, ?, ?, ?)
    `,
    )
    .run(walletId, type, amountWei, txHash);

  return getDatabase()
    .prepare("SELECT * FROM ledger WHERE id = ?")
    .get(result.lastInsertRowid) as LedgerRow;
}

export function getLedgerForWallet(walletId: number): LedgerRow[] {
  return getDatabase()
    .prepare(
      `
      SELECT * FROM ledger
      WHERE wallet_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(walletId) as LedgerRow[];
}

export function resetDatabase(): void {
  closeDatabase();
  if (config.databasePath !== ":memory:" && fs.existsSync(config.databasePath)) {
    fs.unlinkSync(config.databasePath);
  }
}
