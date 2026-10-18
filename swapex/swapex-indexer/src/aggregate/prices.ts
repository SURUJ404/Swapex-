// USD prices from stable-coin reference pools (documented rule): the manifest's
// stable coins (tUSDC, tDAI, ...) are the $1 anchors; a token's USD price is
// read from its most recent swap in a pool against any anchor stable. No
// reference pool -> null (never a made-up price).
import type { Db } from '../db'
import type { Manifest } from '../deployment'

export interface TokenMeta {
  address: string
  symbol: string
  name: string
  decimals: number
}

export type TokenMetaProvider = (address: string) => Promise<TokenMeta>

const STABLE_RE = /usdc|usdt|dai|busd|frax/i

/** Manifest tokens used as $1 anchors (USDC first, then other stables). */
export function referenceStables(manifest: Manifest): TokenMeta[] {
  return manifest.tokens
    .filter((t) => STABLE_RE.test(t.symbol))
    .map((t) => ({ ...t, address: t.address.toLowerCase() }))
}

/** The manifest token used as the primary $1 anchor (USDC first, then DAI). */
export function referenceStable(manifest: Manifest): TokenMeta | null {
  const stables = referenceStables(manifest)
  return stables.find((t) => /usdc/i.test(t.symbol)) ?? stables[0] ?? null
}

interface LatestSwap {
  sqrtPriceX96: string
}

function latestSwapSqrt(db: Db, pool: string): bigint | null {
  const row = db
    .prepare(
      `SELECT args FROM events WHERE address = ? AND event = 'Swap'
       ORDER BY block_number DESC, log_index DESC LIMIT 1`
    )
    .get(pool.toLowerCase()) as { args: string } | undefined
  if (!row) return null
  const sqrt = (JSON.parse(row.args) as { sqrtPriceX96?: string }).sqrtPriceX96
  return sqrt != null ? BigInt(sqrt) : null
}

/**
 * USD price of `token` (any token that appears in a pool against a stable),
 * or null when no reference pool / no swap yet.
 */
export async function tokenUsdPrice(
  db: Db,
  manifest: Manifest,
  token: string,
  meta: TokenMetaProvider
): Promise<number | null> {
  const stables = referenceStables(manifest)
  const tokenAddr = token.toLowerCase()
  const tokenMeta = await meta(tokenAddr)
  if (stables.some((s) => s.address === tokenAddr)) return 1

  for (const stable of stables) {
    const pools = db
      .prepare(
        `SELECT address, token0, token1 FROM pools
         WHERE (token0 = ? AND token1 = ?) OR (token0 = ? AND token1 = ?)`
      )
      .all(tokenAddr, stable.address, stable.address, tokenAddr) as {
      address: string
      token0: string
      token1: string
    }[]

    for (const pool of pools) {
      const sqrt = latestSwapSqrt(db, pool.address)
      if (sqrt == null) continue
      const raw = Number(sqrt) / 2 ** 96
      const rawPrice = raw * raw // token1 per token0, raw units
      if (pool.token0 === tokenAddr) {
        // rawPrice = stable raw per token raw
        return rawPrice * 10 ** (tokenMeta.decimals - stable.decimals)
      }
      // rawPrice = token raw per stable raw -> invert
      return (1 / rawPrice) * 10 ** (stable.decimals - tokenMeta.decimals)
    }
  }
  return null
}
