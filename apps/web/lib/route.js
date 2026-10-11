import { Contract } from 'ethers'
import { FACTORY_ADDRESS, FACTORY_ABI, ROUTER_ADDRESS, ROUTER_ABI, PAIR_ABI } from '../constants'
import { WETH_ADDRESS } from './config'
import { priceImpact } from './amounts'

const ZERO = '0x0000000000000000000000000000000000000000'

export function toPathAddress(token) {
  return token.address === 'NATIVE' ? WETH_ADDRESS : token.address
}

/** Candidate paths: direct, and via WETH when neither side is WETH. */
export function candidatePaths(tokenIn, tokenOut) {
  const a = toPathAddress(tokenIn)
  const b = toPathAddress(tokenOut)
  if (a.toLowerCase() === b.toLowerCase()) return []
  const paths = [[a, b]]
  if (a.toLowerCase() !== WETH_ADDRESS.toLowerCase() && b.toLowerCase() !== WETH_ADDRESS.toLowerCase()) {
    paths.push([a, WETH_ADDRESS, b])
  }
  return paths
}

async function hopReserves(library, tokenA, tokenB) {
  const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, library)
  const pairAddr = await factory.getPair(tokenA, tokenB)
  if (pairAddr === ZERO) return null
  const pair = new Contract(pairAddr, PAIR_ABI, library)
  const [t0, r] = await Promise.all([pair.token0(), pair.getReserves()])
  const aIs0 = t0.toLowerCase() === tokenA.toLowerCase()
  return { reserveIn: aIs0 ? r._reserve0 : r._reserve1, reserveOut: aIs0 ? r._reserve1 : r._reserve0 }
}

/**
 * Quote every candidate path on-chain and return the one with the best output.
 * Returns null when no route has liquidity.
 */
export async function findBestRoute(library, tokenIn, tokenOut, amountIn) {
  const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library)
  const results = await Promise.allSettled(
    candidatePaths(tokenIn, tokenOut).map(async (path) => {
      const amounts = await router.getAmountsOut(amountIn, path)
      const amountOut = amounts[amounts.length - 1]
      if (amountOut.lte(0)) throw new Error('no output')
      let impact = null
      try {
        const hops = await Promise.all(path.slice(0, -1).map((p, i) => hopReserves(library, p, path[i + 1])))
        if (hops.every(Boolean)) {
          impact = priceImpact(amountIn, amountOut, hops, tokenIn.decimals, tokenOut.decimals)
        }
      } catch {
        impact = null
      }
      return { path, amountOut, impact }
    })
  )
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  if (!ok.length) return null
  return ok.reduce((best, r) => (r.amountOut.gt(best.amountOut) ? r : best))
}

/** Pool reserves for a token pair, ordered as (tokenA, tokenB). null if no pool. */
export async function getPoolReserves(library, tokenAAddr, tokenBAddr) {
  const r = await hopReserves(library, tokenAAddr, tokenBAddr)
  return r ? { reserveA: r.reserveIn, reserveB: r.reserveOut } : null
}
