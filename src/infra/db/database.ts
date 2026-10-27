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

export interface PermissionSessionRow {
  id: number;
  wallet_id: number;
  account: string;
  signer_type: string;
  signer_id: string;
  /** Random 32-byte seed. Combined with the account key to derive the session key. */
  session_seed: string;
  /** Absolute expiry, unix seconds. */
  expiry: number;
  granted_at: number;
  permissions: string;
  permissions_hash: string;
  permissions_context: string;
  grant_digest: string;
  grant_signature: string;
  spent_wei: string;
  nonce: number;
  revoked_at: number | null;
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

    CREATE TABLE IF NOT EXISTS permission_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      account TEXT NOT NULL,
      signer_type TEXT NOT NULL CHECK(signer_type IN ('key', 'account')),
      signer_id TEXT NOT NULL,
      session_seed TEXT NOT NULL,
      expiry INTEGER NOT NULL,
      granted_at INTEGER NOT NULL,
      permissions TEXT NOT NULL,
      permissions_hash TEXT NOT NULL,
      permissions_context TEXT NOT NULL UNIQUE,
      grant_digest TEXT NOT NULL,
      grant_signature TEXT NOT NULL,
      spent_wei TEXT NOT NULL DEFAULT '0',
      nonce INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_wallet_id ON permission_sessions(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_context ON permission_sessions(permissions_context);
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

export function getWalletById(id: number): WalletRow | undefined {
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
      WHERE id = ?
    `,
    )
    .get(id) as WalletRow | undefined;
}

export interface NewPermissionSession {
  walletId: number;
  account: string;
  signerType: string;
  signerId: string;
  sessionSeed: string;
  expiry: number;
  grantedAt: number;
  permissions: string;
  permissionsHash: string;
  permissionsContext: string;
  grantDigest: string;
  grantSignature: string;
}

export function insertPermissionSession(
  session: NewPermissionSession,
): PermissionSessionRow {
  const result = getDatabase()
    .prepare(
      `
      INSERT INTO permission_sessions (
        wallet_id, account, signer_type, signer_id, session_seed, expiry,
        granted_at, permissions, permissions_hash, permissions_context,
        grant_digest, grant_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      session.walletId,
      session.account,
      session.signerType,
      session.signerId,
      session.sessionSeed,
      session.expiry,
      session.grantedAt,
      session.permissions,
      session.permissionsHash,
      session.permissionsContext,
      session.grantDigest,
      session.grantSignature,
    );

  return getPermissionSessionById(Number(result.lastInsertRowid))!;
}

const SESSION_COLUMNS = `
  id,
  wallet_id,
  account,
  signer_type,
  signer_id,
  session_seed,
  expiry,
  granted_at,
  permissions,
  permissions_hash,
  permissions_context,
  grant_digest,
  grant_signature,
  spent_wei,
  nonce,
  revoked_at
`;

export function getPermissionSessionById(
  id: number,
): PermissionSessionRow | undefined {
  return getDatabase()
    .prepare(`SELECT ${SESSION_COLUMNS} FROM permission_sessions WHERE id = ?`)
    .get(id) as PermissionSessionRow | undefined;
}

export function getPermissionSessionByContext(
  context: string,
): PermissionSessionRow | undefined {
  return getDatabase()
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM permission_sessions WHERE permissions_context = ?`,
    )
    .get(context) as PermissionSessionRow | undefined;
}

export function getPermissionSessions(walletId?: number): PermissionSessionRow[] {
  if (walletId === undefined) {
    return getDatabase()
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM permission_sessions ORDER BY id DESC`,
      )
      .all() as PermissionSessionRow[];
  }

  return getDatabase()
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM permission_sessions WHERE wallet_id = ? ORDER BY id DESC`,
    )
    .all(walletId) as PermissionSessionRow[];
}

/** Records a redemption: adds to cumulative spend and burns the action nonce. */
export function recordSessionRedemption(
  id: number,
  spentWei: string,
): void {
  getDatabase()
    .prepare(
      `
      UPDATE permission_sessions
      SET spent_wei = ?, nonce = nonce + 1
      WHERE id = ?
    `,
    )
    .run(spentWei, id);
}

export function revokePermissionSession(id: number, revokedAt: number): void {
  getDatabase()
    .prepare(
      `UPDATE permission_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(revokedAt, id);
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
