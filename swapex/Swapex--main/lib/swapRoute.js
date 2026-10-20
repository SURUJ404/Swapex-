// Finding the best swap route with the on-chain quoter, and pricing its impact.
// The quoter runs the real swap against the real pools, so quotes are exact: what it returns
// is what the router will deliver if the pools do not change before the transaction lands.
import { quoteExactInput } from './contracts/quoter'
import { getPool, slot0 } from './contracts/factory'
import { WETH_ADDRESS, FEE_TIERS } from './config'
import { encodePath } from './path'

const ZERO = '0x0000000000000000000000000000000000000000'

export function toPathAddress(token) {
  return token.address === 'NATIVE' ? WETH_ADDRESS : token.address
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase()

/**
 * Every route worth quoting: direct through each fee tier, and through WETH (every fee combination) when
 * neither side is WETH. Each route is { tokens: [..], fees: [..] }.
 */
export function candidateRoutes(tokenIn, tokenOut, weth = WETH_ADDRESS, feeTiers = FEE_TIERS) {
  const a = toPathAddress(tokenIn)
  const b = toPathAddress(tokenOut)
  if (!a || !b || same(a, b)) return []
  const routes = feeTiers.map((f) => ({ tokens: [a, b], fees: [f] }))
  if (weth && !same(a, weth) && !same(b, weth)) {
    for (const f1 of feeTiers) for (const f2 of feeTiers) routes.push({ tokens: [a, weth, b], fees: [f1, f2] })
  }
  return routes
}

/** Pick the route that pays the most. Ties go to fewer hops (cheaper gas). Returns null if none quoted. */
export function pickBest(quotes) {
  const ok = quotes.filter(Boolean)
  if (!ok.length) return null
  return ok.reduce((best, q) => {
    if (q.amountOut > best.amountOut) return q
    if (q.amountOut === best.amountOut && q.fees.length < best.fees.length) return q
    return best
  })
}

/** Quote one route. Throws if a pool is missing or cannot fill the whole trade. */
export async function quoteRoute(client, route, amountIn) {
  const path = encodePath(route.tokens, route.fees)
  const { amountOut, gasEstimate } = await quoteExactInput(client, path, amountIn)
  if (amountOut <= 0n) throw new Error('no output')
  return { ...route, path, amountOut, gasEstimate }
}

/** Mid price of tokenIn in tokenOut (raw units) from a pool's sqrt price. Number precision is fine for display. */
export function hopMidPrice(sqrtPriceX96, tokenIn, tokenOut) {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96
  const price1Per0 = sqrt * sqrt // token1 raw units per token0 raw unit
  return tokenIn.toLowerCase() < tokenOut.toLowerCase() ? price1Per0 : 1 / price1Per0
}

/**
 * Price impact: how much worse the execution price is than the starting mid price, with the pool fees
 * removed (fees are not "impact"). hops: [{ mid, fee }]. Returns a fraction (0.01 = 1%) or null.
 */
export function routeImpact(amountIn, amountOut, hops, decimalsIn, decimalsOut) {
  try {
    if (!hops.length) return null
    let expected = Number(amountIn)
    for (const h of hops) {
      if (!(h.mid > 0)) return null
      expected = expected * h.mid * (1 - h.fee / 1_000_000)
    }
    const out = Number(amountOut)
    if (!(expected > 0)) return null
    // both amounts are raw units already, so decimals only matter for the caller's display
    void decimalsIn
    void decimalsOut
    return Math.max(0, 1 - out / expected)
  } catch {
    return null
  }
}

async function hopsFor(client, route) {
  return Promise.all(
    route.fees.map(async (fee, i) => {
      const tokenIn = route.tokens[i]
      const tokenOut = route.tokens[i + 1]
      const pool = await getPool(client, tokenIn, tokenOut, fee)
      if (pool === ZERO) return null
      const s0 = await slot0(client, pool)
      return { mid: hopMidPrice(s0.sqrtPriceX96, tokenIn, tokenOut), fee }
    })
  )
}

/**
 * Quote every candidate route and return the best, with its price impact.
 * Returns null when no route can fill the trade.
 */
export async function findBestRoute(client, tokenIn, tokenOut, amountIn) {
  const results = await Promise.allSettled(candidateRoutes(tokenIn, tokenOut).map((r) => quoteRoute(client, r, amountIn)))
  const best = pickBest(results.filter((r) => r.status === 'fulfilled').map((r) => r.value))
  if (!best) return null
  let impact = null
  try {
    const hops = await hopsFor(client, best)
    if (hops.every(Boolean)) impact = routeImpact(amountIn, best.amountOut, hops, tokenIn.decimals, tokenOut.decimals)
  } catch {
    impact = null
  }
  return { ...best, impact }
}
