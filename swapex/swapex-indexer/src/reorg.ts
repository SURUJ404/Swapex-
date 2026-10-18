import {
  getCursor,
  setCursor,
  deleteEventsAfter,
  recentBlocksDesc,
  type Db,
} from './db'

/** Minimal chain reads the reorg check needs. */
export interface ReorgClient {
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: string | null } | null>
}

export interface ReorgResult {
  /** Block the cursor was reset to, or null when no reorg was found. */
  rolledBackTo: number | null
  checked: number
}

/**
 * Compare stored block hashes (newest first) against the chain. Reorgs are
 * contiguous from the tip, so the first still-matching block ends the walk.
 * Everything above the fork point — events, pools, block hashes, cursor — is
 * rolled back in one transaction so the next pass re-indexes the new chain.
 */
export async function checkAndRollback(
  client: Pick<ReorgClient, 'getBlock'>,
  db: Db
): Promise<ReorgResult> {
  const stored = recentBlocksDesc(db)
  let rolledBackTo: number | null = null
  let checked = 0

  for (const row of stored) {
    checked += 1
    let onchain: { hash: string | null } | null = null
    try {
      onchain = await client.getBlock({ blockNumber: BigInt(row.number) })
    } catch {
      onchain = null
    }
    const hash = onchain?.hash?.toLowerCase()
    if (hash && hash === row.hash) break // this block is still canonical
    rolledBackTo = row.number - 1
  }

  if (rolledBackTo != null) {
    const cursor = getCursor(db)
    if (cursor != null && rolledBackTo < cursor) {
      const tx = db.transaction(() => {
        deleteEventsAfter(db, rolledBackTo!)
        setCursor(db, rolledBackTo!)
      })
      tx()
    }
  }

  return { rolledBackTo, checked }
}
