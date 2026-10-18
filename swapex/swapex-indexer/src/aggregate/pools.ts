// Derived pool data, computed on demand from the events/blocks tables.
// Exact ledger arithmetic (bigint) for reserves and volumes; token meta and
// USD prices come from injected providers so tests need no RPC.
import type { Db } from '../db'
import type { Manifest } from '../deployment'
import { tokenUsdPrice, type TokenMeta, type TokenMetaProvider } from './prices'
import { priceOf } from './candles'

const DAY = 86400

export interface PoolRow {
  address: string
  token0: string
  token1: string
  fee: number
  tick_spacing: number
  created_block: number
}

export function poolRow(db: Db, address: string): PoolRow | undefined {
  return db.prepare('SELECT * FROM pools WHERE address = ?').get(address.toLowerCase()) as
    | PoolRow
    | undefined
}

export function allPools(db: Db): PoolRow[] {
  return db.prepare('SELECT * FROM pools ORDER BY created_block, address').all() as PoolRow[]
}

interface SwapEventRow {
  args: string
  timestamp: number
  tx_hash: string
}

function swapsSince(db: Db, pool: string, sinceTs: number | null): SwapEventRow[] {
  const sql =
    `SELECT e.args, e.tx_hash, b.timestamp FROM events e
     JOIN blocks b ON b.number = e.block_number
     WHERE e.address = ? AND e.event = 'Swap'` +
    (sinceTs != null ? ' AND b.timestamp >= ?' : '') +
    ' ORDER BY e.block_number, e.log_index'
  const stmt = sinceTs != null ? db.prepare(sql) : db.prepare(sql)
  const rows = sinceTs != null ? stmt.all(pool.toLowerCase(), sinceTs) : stmt.all(pool.toLowerCase())
  return rows as SwapEventRow[]
}

interface AmountEventRow {
  args: string
}

function sumAmounts(db: Db, pool: string, event: string): bigint {
  const rows = db
    .prepare('SELECT args FROM events WHERE address = ? AND event = ?')
    .all(pool.toLowerCase(), event) as AmountEventRow[]
  let total = 0n
  for (const r of rows) {
    const a = JSON.parse(r.args) as { amount0?: string; amount1?: string }
    total += BigInt(a.amount0 ?? '0')
  }
  return total
}

export interface PoolStats {
  address: string
  fee: number
  token0: TokenMeta
  token1: TokenMeta
  /** Latest swap state. */
  price: number | null
  sqrtPriceX96: string | null
  liquidity: string | null
  tick: number | null
  /** 24h trade stats (token0 units for volume). */
  volume24h: number
  fees24h: number
  txCount24h: number
  change24h: number | null
  /** Reserves held by LPs: minted − burned − collected (exact, all time). */
  reserves0: number
  reserves1: number
  tvlUsd: number | null
}

/**
 * Full stats for one pool. TVL is the token ledger (mint − burn − collect)
 * valued at USD prices from the stable-coin reference rule; null when either
 * side has no reference pool. Ignores protocol-fee withdrawals (not decoded).
 */
export async function poolStats(
  db: Db,
  manifest: Manifest,
  pool: string,
  meta: TokenMetaProvider,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<PoolStats | null> {
  const row = poolRow(db, pool)
  if (!row) return null

  const token0 = await meta(row.token0)
  const token1 = await meta(row.token1)

  const recent = swapsSince(db, row.address, nowSec - DAY)
  const all = swapsSince(db, row.address, null)

  let volume0 = 0n
  let fees0 = 0n
  for (const s of recent) {
    const a = JSON.parse(s.args) as { amount0: string }
    const abs = BigInt(a.amount0) < 0n ? -BigInt(a.amount0) : BigInt(a.amount0)
    volume0 += abs
    fees0 += (abs * BigInt(row.fee)) / 1_000_000n
  }

  const last = all[all.length - 1]
  const lastSqrt = last ? BigInt((JSON.parse(last.args) as { sqrtPriceX96: string }).sqrtPriceX96) : null
  const lastLiquidity = last ? (JSON.parse(last.args) as { liquidity: string }).liquidity : null
  const lastTick = last ? (JSON.parse(last.args) as { tick: number }).tick : null

  // 24h change: latest price now vs latest at/before the cutoff.
  let change24h: number | null = null
  if (lastSqrt != null) {
    const before = all.filter((s) => s.timestamp < nowSec - DAY).pop()
    if (before) {
      const oldSqrt = BigInt((JSON.parse(before.args) as { sqrtPriceX96: string }).sqrtPriceX96)
      const pNow = priceOf(lastSqrt, token0.decimals, token1.decimals)
      const pOld = priceOf(oldSqrt, token0.decimals, token1.decimals)
      if (pOld > 0) change24h = (pNow - pOld) / pOld
    }
  }

  const minted0 = sumAmounts(db, row.address, 'Mint')
  const burned0 = sumAmounts(db, row.address, 'Burn')
  const collected0 = sumAmounts(db, row.address, 'Collect')
  const minted1 = sumEvent1(db, row.address, 'Mint')
  const burned1 = sumEvent1(db, row.address, 'Burn')
  const collected1 = sumEvent1(db, row.address, 'Collect')
  const reserves0 = minted0 - burned0 - collected0
  const reserves1 = minted1 - burned1 - collected1

  const price0 = await tokenUsdPrice(db, manifest, row.token0, meta)
  const price1 = await tokenUsdPrice(db, manifest, row.token1, meta)
  const tvlUsd =
    price0 != null && price1 != null
      ? (Number(reserves0) / 10 ** token0.decimals) * price0 +
        (Number(reserves1) / 10 ** token1.decimals) * price1
      : null

  return {
    address: row.address,
    fee: row.fee,
    token0,
    token1,
    price: lastSqrt != null ? priceOf(lastSqrt, token0.decimals, token1.decimals) : null,
    sqrtPriceX96: lastSqrt?.toString() ?? null,
    liquidity: lastLiquidity ?? null,
    tick: lastTick ?? null,
    volume24h: Number(volume0) / 10 ** token0.decimals,
    fees24h: Number(fees0) / 10 ** token0.decimals,
    txCount24h: recent.length,
    change24h,
    reserves0: Number(reserves0) / 10 ** token0.decimals,
    reserves1: Number(reserves1) / 10 ** token1.decimals,
    tvlUsd,
  }
}

function sumEvent1(db: Db, pool: string, event: string): bigint {
  const rows = db
    .prepare('SELECT args FROM events WHERE address = ? AND event = ?')
    .all(pool.toLowerCase(), event) as AmountEventRow[]
  let total = 0n
  for (const r of rows) {
    const a = JSON.parse(r.args) as { amount1?: string }
    total += BigInt(a.amount1 ?? '0')
  }
  return total
}

export interface SwapListItem {
  txHash: string
  timestamp: number
  amount0: number
  amount1: number
  sqrtPriceX96: string
  tick: number
}

export function listSwaps(
  db: Db,
  pool: string,
  token0: TokenMeta,
  token1: TokenMeta,
  page: { limit: number; offset: number }
): SwapListItem[] {
  const rows = db
    .prepare(
      `SELECT e.args, e.tx_hash, b.timestamp FROM events e
       JOIN blocks b ON b.number = e.block_number
       WHERE e.address = ? AND e.event = 'Swap'
       ORDER BY e.block_number DESC, e.log_index DESC
       LIMIT ? OFFSET ?`
    )
    .all(pool.toLowerCase(), page.limit, page.offset) as SwapEventRow[]
  return rows.map((r) => {
    const a = JSON.parse(r.args) as {
      amount0: string
      amount1: string
      sqrtPriceX96: string
      tick: number
    }
    return {
      txHash: r.tx_hash,
      timestamp: r.timestamp,
      amount0: Number(a.amount0) / 10 ** token0.decimals,
      amount1: Number(a.amount1) / 10 ** token1.decimals,
      sqrtPriceX96: a.sqrtPriceX96,
      tick: a.tick,
    }
  })
}

export interface PositionSummary {
  tokenId: string
  owner: string | null
  liquidityAdded: string
  liquidityRemoved: string
  /** Raw token units as strings; the pair's decimals need an on-chain read. */
  feesCollected0Raw: string
  feesCollected1Raw: string
}

/**
 * Position NFTs currently owned by `owner` (ownership from Transfer events on
 * the position manager), with ledger sums for liquidity and fees in raw units.
 * Pair metadata needs an on-chain read and is intentionally not fabricated here.
 */
export function positionsByOwner(
  db: Db,
  owner: string,
  positionManager: string
): PositionSummary[] {
  const ownerAddr = owner.toLowerCase()
  const pm = positionManager.toLowerCase()

  const transfers = db
    .prepare(
      `SELECT args, block_number, log_index FROM events
       WHERE address = ? AND event = 'Transfer'
       ORDER BY block_number, log_index`
    )
    .all(pm) as { args: string }[]

  const current = new Map<string, string>()
  for (const t of transfers) {
    const a = JSON.parse(t.args) as { from: string; to: string; tokenId: string }
    current.set(a.tokenId, a.to.toLowerCase())
  }

  const ledger = db
    .prepare(
      `SELECT event, args FROM events
       WHERE address = ? AND event IN ('IncreaseLiquidity','DecreaseLiquidity','Collect')
       ORDER BY block_number, log_index`
    )
    .all(pm) as { event: string; args: string }[]

  const perToken = new Map<string, { added: bigint; removed: bigint; fee0: bigint; fee1: bigint }>()
  for (const e of ledger) {
    const a = JSON.parse(e.args) as {
      tokenId: string
      liquidity?: string
      amount0?: string
      amount1?: string
    }
    let t = perToken.get(a.tokenId)
    if (!t) {
      t = { added: 0n, removed: 0n, fee0: 0n, fee1: 0n }
      perToken.set(a.tokenId, t)
    }
    if (e.event === 'IncreaseLiquidity') t.added += BigInt(a.liquidity ?? '0')
    if (e.event === 'DecreaseLiquidity') t.removed += BigInt(a.liquidity ?? '0')
    if (e.event === 'Collect') {
      t.fee0 += BigInt(a.amount0 ?? '0')
      t.fee1 += BigInt(a.amount1 ?? '0')
    }
  }

  const out: PositionSummary[] = []
  for (const [tokenId, ownerNow] of current) {
    if (ownerNow !== ownerAddr) continue
    const t = perToken.get(tokenId) ?? { added: 0n, removed: 0n, fee0: 0n, fee1: 0n }
    out.push({
      tokenId,
      owner: ownerNow,
      liquidityAdded: t.added.toString(),
      liquidityRemoved: t.removed.toString(),
      feesCollected0Raw: t.fee0.toString(),
      feesCollected1Raw: t.fee1.toString(),
    })
  }
  return out.sort((a, b) => Number(b.tokenId) - Number(a.tokenId))
}
