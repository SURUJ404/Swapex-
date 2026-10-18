import type { ChainClient } from './chain'
import type { Manifest } from './deployment'
import { decodeLogs } from './decode'
import { getCursor, setCursor, insertEvents, insertPool, poolAddresses, type Db, type StoredEvent } from './db'

/** Max blocks per pass. Keeps RPC responses bounded on busy chains. */
export const BATCH_SIZE = 500

export interface IndexResult {
  from: number
  to: number
  head: number
  events: number
}

/**
 * One indexing pass: from cursor+1 (or the manifest's deployment block) up to head,
 * capped at BATCH_SIZE. Addresses = factory + position manager + every pool seen so
 * far; a PoolCreated inside the range triggers an extra fetch for the new pool so
 * same-range pool events are not missed. Events, pools and the cursor are committed
 * in one SQLite transaction, so a crash mid-pass cannot leave a half-applied range.
 */
export async function runOnce(
  client: Pick<ChainClient, 'getBlockNumber' | 'getLogs'>,
  db: Db,
  manifest: Manifest
): Promise<IndexResult | null> {
  const head = Number(await client.getBlockNumber())
  const last = getCursor(db)
  const from = last != null ? last + 1 : manifest.blockNumber
  if (from > head) return null
  const to = Math.min(head, from + BATCH_SIZE - 1)

  const known = new Set(
    [manifest.factory, manifest.positionManager, ...poolAddresses(db)].map((a) => a.toLowerCase())
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
    setCursor(db, to)
  })
  store(events)

  return { from, to, head, events: events.length }
}
