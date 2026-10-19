import type { ChainClient } from './chain'
import type { Manifest } from './deployment'
import { decodeLogs } from './decode'
import {
  getCursor,
  setCursor,
  insertEvents,
  insertPool,
  poolAddresses,
  recordBlock,
  type Db,
  type StoredEvent,
} from './db'
import { checkAndRollback } from './reorg'

/** Max blocks per pass. Keeps RPC responses bounded on busy chains. */
export const BATCH_SIZE = 500

export interface IndexResult {
  from: number
  to: number
  head: number
  events: number
  reorg: boolean
}

type IndexClient = Pick<ChainClient, 'getBlockNumber' | 'getLogs' | 'getBlock'>

/**
 * One indexing pass.
 * 1. Reorg check: stored hashes in the unfinalized window are compared against the
 *    chain; a mismatch rolls events/pools/cursor back to the fork point.
 * 2. Index forward from cursor+1 (or the manifest's deployment block), capped at
 *    BATCH_SIZE. Addresses = factory + position manager + limit-order contract +
 *    every pool seen so far; a PoolCreated inside the range triggers an extra
 *    fetch for the new pool so same-range pool events are not missed.
 * 3. Store block hashes for the last `reorgDepth` blocks so the next pass can
 *    detect a reorg, and commit everything in one SQLite transaction per step.
 */
export async function runOnce(
  client: IndexClient,
  db: Db,
  manifest: Manifest,
  reorgDepth = 12
): Promise<IndexResult | null> {
  const reorg = await checkAndRollback(client, db, reorgDepth)

  const head = Number(await client.getBlockNumber())
  const last = getCursor(db)
  const from = last != null ? last + 1 : manifest.blockNumber
  if (from > head) return null
  const to = Math.min(head, from + BATCH_SIZE - 1)

  const known = new Set(
    [
      manifest.factory,
      manifest.positionManager,
      ...(manifest.limitOrders ? [manifest.limitOrders] : []),
      ...poolAddresses(db),
    ].map((a) => a.toLowerCase())
  )

  const fetchLogs = async (addresses: string[]) => {
    if (addresses.length === 0) return []
    return client.getLogs({ address: addresses as `0x${string}`[], fromBlock: BigInt(from), toBlock: BigInt(to) })
  }

  let events = decodeLogs(await fetchLogs([...known]))

  // Pools created inside this range: pick up their events too.
  for (;;) {
    const newPools = [
      ...new Set(
        events
          .filter((e) => e.event === 'PoolCreated')
          .map((e) => (JSON.parse(e.args) as { pool?: string }).pool)
          .filter((a): a is string => typeof a === 'string' && !known.has(a.toLowerCase()))
      ),
    ]
    if (newPools.length === 0) break
    for (const p of newPools) known.add(p.toLowerCase())
    events = events.concat(decodeLogs(await fetchLogs(newPools)))
  }

  // Hashes + timestamps: every event-bearing block (time windows and candles need
  // timestamps) plus the unfinalized window (reorg checks need hashes).
  const windowFrom = Math.max(from, to - reorgDepth + 1)
  const wanted = new Set<number>()
  for (let n = windowFrom; n <= to; n++) wanted.add(n)
  for (const e of events) wanted.add(e.blockNumber)
  const blocks = new Map<number, { hash: string; parentHash: string; timestamp: number }>()
  for (const n of wanted) {
    const block = await client.getBlock({ blockNumber: BigInt(n) })
    if (block?.hash) {
      blocks.set(n, {
        hash: block.hash,
        parentHash: block.parentHash ?? '0x',
        timestamp: Number(block.timestamp ?? 0),
      })
    }
  }

  const store = db.transaction((batch: StoredEvent[]) => {
    insertEvents(db, batch)
    for (const e of batch) {
      if (e.event !== 'PoolCreated') continue
      const a = JSON.parse(e.args) as {
        pool: string
        token0: string
        token1: string
        fee: string | number
        tickSpacing: string | number
      }
      insertPool(db, {
        address: a.pool,
        token0: a.token0,
        token1: a.token1,
        fee: Number(a.fee),
        tickSpacing: Number(a.tickSpacing),
        createdBlock: e.blockNumber,
      })
    }
    for (const [number, { hash, parentHash, timestamp }] of blocks) {
      recordBlock(db, { number, hash, parentHash, timestamp })
    }
    setCursor(db, to)
  })
  store(events)

  return { from, to, head, events: events.length, reorg: reorg.rolledBackTo != null }
}
