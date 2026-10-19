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
      parent_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_hash TEXT PRIMARY KEY,
      maker TEXT NOT NULL,
      token_in TEXT NOT NULL,
      token_out TEXT NOT NULL,
      amount_in TEXT NOT NULL,
      min_amount_out TEXT NOT NULL,
      expiry INTEGER NOT NULL,
      nonce INTEGER NOT NULL,
      receiver TEXT NOT NULL,
      fee INTEGER NOT NULL,
      signature TEXT NOT NULL,
      verifying_contract TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      submitted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_maker ON orders(maker, nonce);
    CREATE INDEX IF NOT EXISTS idx_orders_submitted ON orders(submitted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_addr_event ON events(address, event);
  `)
  // Migrate databases created before block timestamps existed.
  const cols = db.prepare('PRAGMA table_info(blocks)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'timestamp')) {
    db.exec('ALTER TABLE blocks ADD COLUMN timestamp INTEGER NOT NULL DEFAULT 0')
  }
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
  timestamp: number
}

/** Remember a block's hash + timestamp (for reorg checks and time windows). */
export function recordBlock(db: Db, block: StoredBlock): void {
  db.prepare(
    `INSERT OR REPLACE INTO blocks (number, hash, parent_hash, timestamp) VALUES (?, ?, ?, ?)`
  ).run(block.number, block.hash.toLowerCase(), block.parentHash.toLowerCase(), block.timestamp)
}

/** Unix timestamp (seconds) of a block we stored, or null. */
export function blockTimestamp(db: Db, blockNumber: number): number | null {
  const row = db.prepare('SELECT timestamp FROM blocks WHERE number = ?').get(blockNumber) as
    | { timestamp: number }
    | undefined
  return row && row.timestamp > 0 ? row.timestamp : null
}

export function deleteBlocksAfter(db: Db, block: number): void {
  db.prepare('DELETE FROM blocks WHERE number > ?').run(block)
}

/** Drop block hashes older than `before` (the window is all reorg checks need). */
export function pruneBlocksBefore(db: Db, before: number): void {
  db.prepare('DELETE FROM blocks WHERE number < ?').run(before)
}

/** Stored block hashes, newest first (reorg checks walk this). */
export function recentBlocksDesc(db: Db): StoredBlock[] {
  const rows = db
    .prepare('SELECT number, hash, parent_hash, timestamp FROM blocks ORDER BY number DESC')
    .all() as { number: number; hash: string; parent_hash: string; timestamp: number }[]
  return rows.map((r) => ({ number: r.number, hash: r.hash, parentHash: r.parent_hash, timestamp: r.timestamp }))
}

// ---------------------------------------------------------------- orders
/**
 * A submitted limit order: the signed EIP-712 payload plus the pool fee tier to
 * fill against (not part of the signature). Fill/cancel state is *not* stored
 * here - it is derived from OrderFilled/OrderCancelled events at read time, so it
 * rolls back with the events on a reorg (same idempotence rule as the rest).
 */
export interface OrderRow {
  orderHash: string
  maker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: number
  nonce: string // uint256 decimal string: nonces are not bounded to 2^53
  receiver: string
  fee: number
  signature: string
  verifyingContract: string
  chainId: number
  submittedAt: number
}

const ORDER_COLUMNS =
  'order_hash, maker, token_in, token_out, amount_in, min_amount_out, expiry, nonce, receiver, fee, signature, verifying_contract, chain_id, submitted_at'

function rowToOrder(r: Record<string, unknown>): OrderRow {
  return {
    orderHash: r.order_hash as string,
    maker: r.maker as string,
    tokenIn: r.token_in as string,
    tokenOut: r.token_out as string,
    amountIn: r.amount_in as string,
    minAmountOut: r.min_amount_out as string,
    expiry: r.expiry as number,
    nonce: String(r.nonce),
    receiver: r.receiver as string,
    fee: r.fee as number,
    signature: r.signature as string,
    verifyingContract: r.verifying_contract as string,
    chainId: r.chain_id as number,
    submittedAt: r.submitted_at as number,
  }
}

/**
 * Store an order keyed by its EIP-712 hash (the payload is fully determined by the
 * hash, so the only cross-field conflict possible is the un-signed fee tier).
 * Returns 'inserted' | 'duplicate' (same order, same fee) | 'fee-conflict'.
 */
export function insertOrder(db: Db, order: OrderRow): 'inserted' | 'duplicate' | 'fee-conflict' {
  const existing = db.prepare('SELECT fee FROM orders WHERE order_hash = ?').get(order.orderHash) as
    | { fee: number }
    | undefined
  if (existing) return existing.fee === order.fee ? 'duplicate' : 'fee-conflict'
  db.prepare(
    `INSERT INTO orders (order_hash, maker, token_in, token_out, amount_in, min_amount_out, expiry, nonce, receiver, fee, signature, verifying_contract, chain_id, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    order.orderHash,
    order.maker,
    order.tokenIn,
    order.tokenOut,
    order.amountIn,
    order.minAmountOut,
    order.expiry,
    order.nonce,
    order.receiver,
    order.fee,
    order.signature,
    order.verifyingContract,
    order.chainId,
    order.submittedAt
  )
  return 'inserted'
}

export function getOrder(db: Db, orderHash: string): OrderRow | null {
  const r = db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_hash = ?`).get(orderHash) as
    | Record<string, unknown>
    | undefined
  return r ? rowToOrder(r) : null
}

/** Submitted orders, newest first, optionally filtered by maker. Omit `limit` to fetch all. */
export function listOrders(
  db: Db,
  filter: { maker?: string; limit?: number; offset?: number }
): { rows: OrderRow[]; total: number } {
  const where = filter.maker ? 'WHERE maker = ?' : ''
  const params: (string | number)[] = filter.maker ? [filter.maker.toLowerCase()] : []
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`).get(...params) as { n: number }
  ).n
  const page = filter.limit != null ? ' LIMIT ? OFFSET ?' : ''
  const pageParams: number[] = filter.limit != null ? [filter.limit, filter.offset ?? 0] : []
  const rows = db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders ${where} ORDER BY submitted_at DESC, order_hash${page}`)
    .all(...params, ...pageParams) as Record<string, unknown>[]
  return { rows: rows.map(rowToOrder), total }
}
