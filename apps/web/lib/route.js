import { utils } from 'ethers'
import { buildPoolKey, isZeroForOne, quoteExactInputSingle, getPoolState, priceFromSqrt, toCurrencyAddress } from './pool'

/**
 * Quote a direct (single-hop) swap between two tokens through the on-chain Quoter and return the
 * best available result in the shape the swap UI expects: `{ amountOut, path, impact, key,
 * zeroForOne }`. Replaces the V2 factory/router path search — a V4 pool is uniquely identified by
 * its PoolKey, so there is exactly one direct pool per pair per fee tier.
 */
export async function findBestRoute(library, tokenIn, tokenOut, amountIn) {
  const key = buildPoolKey(tokenIn, tokenOut)
  const zeroForOne = isZeroForOne(key, tokenIn)

  const { amountOut } = await quoteExactInputSingle(library, key, zeroForOne, amountIn)
  if (!amountOut || amountOut.lte(0)) return null

  return {
    amountOut,
    key,
    zeroForOne,
    path: [toCurrencyAddress(tokenIn), toCurrencyAddress(tokenOut)],
    impact: await priceImpact(library, key, zeroForOne, tokenIn, tokenOut, amountIn, amountOut),
  }
}

/** Execution price vs. spot price, as a fraction (0.01 = 1% worse than spot). Null when unknown. */
async function priceImpact(library, key, zeroForOne, tokenIn, tokenOut, amountIn, amountOut) {
  try {
    const { sqrtPriceX96 } = await getPoolState(library, key)
    // spot (tokenOut per tokenIn): token1/token0 when selling currency0, else its reciprocal.
    const c0Decimals = zeroForOne ? tokenIn.decimals : tokenOut.decimals
    const c1Decimals = zeroForOne ? tokenOut.decimals : tokenIn.decimals
    const token1Per0 = priceFromSqrt(sqrtPriceX96, c0Decimals, c1Decimals)
    if (!(token1Per0 > 0)) return null
    const spot = zeroForOne ? token1Per0 : 1 / token1Per0

    const inUnits = Number(utils.formatUnits(amountIn, tokenIn.decimals))
    const outUnits = Number(utils.formatUnits(amountOut, tokenOut.decimals))
    if (!(inUnits > 0) || !(spot > 0)) return null
    const exec = outUnits / inUnits
    return Math.max(0, 1 - exec / spot)
  } catch {
    return null
  }
}
