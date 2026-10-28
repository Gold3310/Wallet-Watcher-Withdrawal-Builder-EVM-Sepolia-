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
  /** API token id that requested the movement; null for polled inflows. */
  actor: string | null;
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

/**
 * Additive column migration. Older databases were created before `ledger.actor`
 * existed, so it is added on first open rather than breaking them.
 */
function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];

  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    ensureDatabaseDirectory(config.databasePath);
    db = new Database(config.databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeSchema(db);
    ensureColumn(db, "ledger", "actor", "actor TEXT");
    bindNetwork(db, config.network, config.chainId);
  }
  return db;
}

/**
 * Addresses are identical across chains (same mnemonic), so balances and the
 * ledger are only meaningful per network. Pin the network to the database and
 * refuse to open it on a different chain rather than silently mixing ledgers.
 */
function bindNetwork(
  database: Database.Database,
  network: string,
  chainId: number,
): void {
  const row = database
    .prepare("SELECT value FROM meta WHERE key = 'network'")
    .get() as { value: string } | undefined;

  if (!row) {
    database
      .prepare("INSERT INTO meta (key, value) VALUES ('network', ?)")
      .run(network);
    database
      .prepare("INSERT INTO meta (key, value) VALUES ('chain_id', ?)")
      .run(String(chainId));
    return;
  }

  if (row.value !== network) {
    throw new Error(
      `Database at ${config.databasePath} belongs to network '${row.value}', ` +
        `refusing to run on '${network}'. Set DATABASE_PATH per chain.`,
    );
  }
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      actor TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed')),
      status_code INTEGER,
      response TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency(created_at);
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
  actor: string | null = null,
): LedgerRow {
  const result = getDatabase()
    .prepare(
      `
      INSERT INTO ledger (wallet_id, type, amount_wei, tx_hash, actor)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(walletId, type, amountWei, txHash, actor);

  return getDatabase()
    .prepare("SELECT * FROM ledger WHERE id = ?")
    .get(result.lastInsertRowid) as LedgerRow;
}

/** Outflow total for a wallet over the trailing window, summed with BigInt. */
export function getOutflowTotalSince(
  walletId: number,
  seconds: number,
): bigint {
  const rows = getDatabase()
    .prepare(
      `
      SELECT amount_wei
      FROM ledger
      WHERE wallet_id = ?
        AND type = 'outflow'
        AND created_at >= datetime('now', ?)
    `,
    )
    .all(walletId, `-${Math.max(0, Math.floor(seconds))} seconds`) as {
    amount_wei: string;
  }[];

  return rows.reduce((total, row) => total + BigInt(row.amount_wei), 0n);
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

export interface SpendReservation {
  ok: boolean;
  /** Nonce assigned to this action; the stored nonce is already advanced. */
  nonce: number;
  spentWei: string;
  reason?: string;
}

/**
 * Reserve spend against a session's cap and claim its action nonce, atomically.
 *
 * This has to be one immediate transaction: reading the row, checking the cap
 * and writing the new total across separate statements lets two concurrent
 * redemptions both read the same `spent_wei` and both pass, moving more than
 * the cap allows. Everything inside the transaction callback is synchronous.
 */
export function reserveSessionSpend(params: {
  id: number;
  amountWei: string;
  cap: bigint | null;
  now: number;
}): SpendReservation {
  const database = getDatabase();

  const run = database.transaction((input: typeof params): SpendReservation => {
    const row = database
      .prepare(
        "SELECT id, expiry, spent_wei, nonce, revoked_at FROM permission_sessions WHERE id = ?",
      )
      .get(input.id) as
      | {
          id: number;
          expiry: number;
          spent_wei: string;
          nonce: number;
          revoked_at: number | null;
        }
      | undefined;

    if (!row) {
      return { ok: false, nonce: 0, spentWei: "0", reason: `Permission session ${input.id} does not exist` };
    }

    if (row.revoked_at !== null) {
      return {
        ok: false,
        nonce: row.nonce,
        spentWei: row.spent_wei,
        reason: `Permission session ${input.id} was revoked at ${new Date(row.revoked_at * 1000).toISOString()}`,
      };
    }

    if (input.now >= row.expiry) {
      return {
        ok: false,
        nonce: row.nonce,
        spentWei: row.spent_wei,
        reason: `Permission session ${input.id} expired at ${new Date(row.expiry * 1000).toISOString()}`,
      };
    }

    const amount = BigInt(input.amountWei);
    const spent = BigInt(row.spent_wei);
    const next = spent + amount;

    if (input.cap !== null && next > input.cap) {
      return {
        ok: false,
        nonce: row.nonce,
        spentWei: row.spent_wei,
        reason: `Amount ${amount} wei exceeds the remaining spending cap of ${input.cap - spent} wei`,
      };
    }

    database
      .prepare(
        "UPDATE permission_sessions SET spent_wei = ?, nonce = nonce + 1 WHERE id = ?",
      )
      .run(next.toString(), input.id);

    return { ok: true, nonce: row.nonce, spentWei: next.toString() };
  });

  return run.immediate(params);
}

/**
 * Give back a reservation when the redemption failed after reserving — before
 * any funds moved, so the cap and nonce must not stay consumed.
 */
export function releaseSessionSpend(id: number, amountWei: string): void {
  const database = getDatabase();

  const run = database.transaction((input: { id: number; amountWei: string }) => {
    const row = database
      .prepare("SELECT spent_wei FROM permission_sessions WHERE id = ?")
      .get(input.id) as { spent_wei: string } | undefined;

    if (!row) {
      return;
    }

    const next = BigInt(row.spent_wei) - BigInt(input.amountWei);
    database
      .prepare(
        "UPDATE permission_sessions SET spent_wei = ?, nonce = MAX(0, nonce - 1) WHERE id = ?",
      )
      .run((next > 0n ? next : 0n).toString(), input.id);
  });

  run.immediate({ id, amountWei });
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

export interface IdempotencyRow {
  key: string;
  scope: string;
  actor: string;
  request_hash: string;
  status: string;
  status_code: number | null;
  response: string | null;
  created_at: string;
  completed_at: string | null;
}

export function readIdempotencyRecord(
  key: string,
): IdempotencyRow | undefined {
  return getDatabase()
    .prepare("SELECT * FROM idempotency WHERE key = ?")
    .get(key) as IdempotencyRow | undefined;
}

export function insertIdempotencyRecord(record: {
  key: string;
  scope: string;
  actor: string;
  requestHash: string;
}): void {
  getDatabase()
    .prepare(
      `
      INSERT INTO idempotency (key, scope, actor, request_hash, status)
      VALUES (?, ?, ?, ?, 'in_progress')
    `,
    )
    .run(record.key, record.scope, record.actor, record.requestHash);
}

export function completeIdempotentRequest(
  key: string,
  statusCode: number,
  response: string,
): void {
  getDatabase()
    .prepare(
      `
      UPDATE idempotency
      SET status = 'completed', status_code = ?, response = ?, completed_at = datetime('now')
      WHERE key = ?
    `,
    )
    .run(statusCode, response, key);
}

export function resetDatabase(): void {
  closeDatabase();
  if (config.databasePath !== ":memory:" && fs.existsSync(config.databasePath)) {
    fs.unlinkSync(config.databasePath);
  }
}
