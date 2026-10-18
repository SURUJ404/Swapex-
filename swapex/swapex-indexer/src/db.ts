import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

export interface StoredEvent {
  logId: string
  blockNumber: number
  blockHash: string
  txHash: string
  logIndex: number
  address: string
  event: string
  args: string
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_block INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      log_id TEXT PRIMARY KEY,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      address TEXT NOT NULL,
      event TEXT NOT NULL,
      args TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
    CREATE TABLE IF NOT EXISTS pools (
      address TEXT PRIMARY KEY,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      fee INTEGER NOT NULL,
      tick_spacing INTEGER NOT NULL,
      created_block INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blocks (
      number INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      parent_hash TEXT NOT NULL
    );
  `)
  return db
}

/** Last fully processed block, or null when nothing has been indexed yet. */
export function getCursor(db: Db): number | null {
  const row = db.prepare('SELECT last_block FROM cursor WHERE id = 1').get() as { last_block: number } | undefined
  return row ? row.last_block : null
}

export function setCursor(db: Db, block: number): void {
  db.prepare(
    `INSERT INTO cursor (id, last_block, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`
  ).run(block, new Date().toISOString())
}

/** Insert decoded events; existing log ids are skipped (safe to re-deliver). */
export function insertEvents(db: Db, events: StoredEvent[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO events (log_id, block_number, block_hash, tx_hash, log_index, address, event, args)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  let inserted = 0
  for (const e of events) {
    inserted += stmt.run(e.logId, e.blockNumber, e.blockHash, e.txHash, e.logIndex, e.address, e.event, e.args).changes
  }
  return inserted
}

export function insertPool(
  db: Db,
  pool: { address: string; token0: string; token1: string; fee: number; tickSpacing: number; createdBlock: number }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pools (address, token0, token1, fee, tick_spacing, created_block)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(pool.address.toLowerCase(), pool.token0.toLowerCase(), pool.token1.toLowerCase(), pool.fee, pool.tickSpacing, pool.createdBlock)
}

export function poolAddresses(db: Db): string[] {
  const rows = db.prepare('SELECT address FROM pools').all() as { address: string }[]
  return rows.map((r) => r.address)
}

/** Roll back everything after `block` (used when a reorg is detected). */
export function deleteEventsAfter(db: Db, block: number): void {
  db.prepare('DELETE FROM events WHERE block_number > ?').run(block)
  db.prepare('DELETE FROM pools WHERE created_block > ?').run(block)
  deleteBlocksAfter(db, block)
}

export interface StoredBlock {
  number: number
  hash: string
  parentHash: string
}

/** Remember a block's hash (within the unfinalized window) for later reorg checks. */
export function recordBlock(db: Db, block: StoredBlock): void {
  db.prepare(
    `INSERT OR REPLACE INTO blocks (number, hash, parent_hash) VALUES (?, ?, ?)`
  ).run(block.number, block.hash.toLowerCase(), block.parentHash.toLowerCase())
}

/** Stored block hashes, newest first. */
export function recentBlocksDesc(db: Db): StoredBlock[] {
  const rows = db
    .prepare('SELECT number, hash, parent_hash FROM blocks ORDER BY number DESC')
    .all() as { number: number; hash: string; parent_hash: string }[]
  return rows.map((r) => ({ number: r.number, hash: r.hash, parentHash: r.parent_hash }))
}

export function deleteBlocksAfter(db: Db, block: number): void {
  db.prepare('DELETE FROM blocks WHERE number > ?').run(block)
}

/** Drop block hashes older than `before` (the window is all reorg checks need). */
export function pruneBlocksBefore(db: Db, before: number): void {
  db.prepare('DELETE FROM blocks WHERE number < ?').run(before)
}
