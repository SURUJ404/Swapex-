// Finding the best swap route with the on-chain quoter, and pricing its impact.
// The quoter runs the real swap against the real pools and reverts, so quotes are exact: what it returns
// is what the router will deliver if the pools do not change before the transaction lands.
import { Contract, BigNumber } from 'ethers'
import quoterAbi from './abi/SwapexQuoter.json'
import factoryAbi from './abi/SwapexFactory.json'
import poolAbi from './abi/SwapexPool.json'
import { DEPLOYMENT, WETH_ADDRESS, FEE_TIERS } from './config'
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
    if (q.amountOut.gt(best.amountOut)) return q
    if (q.amountOut.eq(best.amountOut) && q.fees.length < best.fees.length) return q
    return best
  })
}

/** Quote one route. Throws if a pool is missing or cannot fill the whole trade. */
export async function quoteRoute(library, route, amountIn) {
  const quoter = new Contract(DEPLOYMENT.quoter, quoterAbi, library)
  const path = encodePath(route.tokens, route.fees)
  const r = await quoter.callStatic.quoteExactInput(path, amountIn)
  const amountOut = BigNumber.from(r.amountOut)
  if (amountOut.lte(0)) throw new Error('no output')
  return { ...route, path, amountOut, gasEstimate: BigNumber.from(r.gasEstimate) }
}

/** Mid price of tokenIn in tokenOut (raw units) from a pool's sqrt price. Number precision is fine for display. */
export function hopMidPrice(sqrtPriceX96, tokenIn, tokenOut) {
  const sqrt = Number(BigNumber.from(sqrtPriceX96).toString()) / 2 ** 96
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
    let expected = Number(BigNumber.from(amountIn).toString())
    for (const h of hops) {
      if (!(h.mid > 0)) return null
      expected = expected * h.mid * (1 - h.fee / 1_000_000)
    }
    const out = Number(BigNumber.from(amountOut).toString())
    if (!(expected > 0)) return null
    // both amounts are raw units already, so decimals only matter for the caller's display
    void decimalsIn
    void decimalsOut
    return Math.max(0, 1 - out / expected)
  } catch {
    return null
  }
}

async function hopsFor(library, route) {
  const factory = new Contract(DEPLOYMENT.factory, factoryAbi, library)
  return Promise.all(
    route.fees.map(async (fee, i) => {
      const tokenIn = route.tokens[i]
      const tokenOut = route.tokens[i + 1]
      const pool = await factory.getPool(tokenIn, tokenOut, fee)
      if (pool === ZERO) return null
      const slot0 = await new Contract(pool, poolAbi, library).slot0()
      return { mid: hopMidPrice(slot0.sqrtPriceX96, tokenIn, tokenOut), fee }
    })
  )
}

/**
 * Quote every candidate route and return the best, with its price impact.
 * Returns null when no route can fill the trade.
 */
export async function findBestRoute(library, tokenIn, tokenOut, amountIn) {
  const results = await Promise.allSettled(candidateRoutes(tokenIn, tokenOut).map((r) => quoteRoute(library, r, amountIn)))
  const best = pickBest(results.filter((r) => r.status === 'fulfilled').map((r) => r.value))
  if (!best) return null
  let impact = null
  try {
    const hops = await hopsFor(library, best)
    if (hops.every(Boolean)) impact = routeImpact(amountIn, best.amountOut, hops, tokenIn.decimals, tokenOut.decimals)
  } catch {
    impact = null
  }
  return { ...best, impact }
}
