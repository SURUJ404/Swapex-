import { BigNumber } from 'ethers'
import { getSqrtRatioAtTick, fullRangeTicks } from './tickMath.js'

export { fullRangeTicks }

// Port of the standard amounts->liquidity helpers (the same math the contracts use when turning
// a liquidity delta into token amounts). Uses ethers BigNumber, which is arbitrary-precision, so
// the full-precision mulDiv products cannot overflow.

const Q96 = BigNumber.from(2).pow(96)

/** floor(a * b / denominator). */
function mulDiv(a, b, denominator) {
  return a.mul(b).div(denominator)
}

/** floor(a * b / denominator), rounded up. */
function mulDivRoundingUp(a, b, denominator) {
  const product = a.mul(b)
  let result = product.div(denominator)
  if (!product.mod(denominator).isZero()) result = result.add(1)
  return result
}

function sortSqrt(a, b) {
  return a.lte(b) ? [a, b] : [b, a]
}

/** Liquidity backed by `amount0` over the [sqrtA, sqrtB] range (sqrtA <= sqrtB). */
export function getLiquidityForAmount0(sqrtA, sqrtB, amount0) {
  const [lo, hi] = sortSqrt(sqrtA, sqrtB)
  const intermediate = mulDiv(lo, hi, Q96)
  return mulDiv(amount0, intermediate, hi.sub(lo))
}

/** Liquidity backed by `amount1` over the [sqrtA, sqrtB] range (sqrtA <= sqrtB). */
export function getLiquidityForAmount1(sqrtA, sqrtB, amount1) {
  const [lo, hi] = sortSqrt(sqrtA, sqrtB)
  return mulDiv(amount1, Q96, hi.sub(lo))
}

/**
 * The largest liquidity that can be added with `amount0` + `amount1` at the current price
 * `sqrtPriceX96`, bounded by the tighter of the two sides. This is what a concentrated position
 * can actually hold: the unused side is simply not deposited.
 */
export function getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, amount0, amount1) {
  const [lo, hi] = sortSqrt(sqrtA, sqrtB)
  if (sqrtPriceX96.lte(lo)) return getLiquidityForAmount0(lo, hi, amount0)
  if (sqrtPriceX96.lt(hi)) {
    const liq0 = getLiquidityForAmount0(sqrtPriceX96, hi, amount0)
    const liq1 = getLiquidityForAmount1(lo, sqrtPriceX96, amount1)
    return liq0.lt(liq1) ? liq0 : liq1
  }
  return getLiquidityForAmount1(lo, hi, amount1)
}

/** Liquidity + the full-range bounds for a pool, from a current price and the desired amounts. */
export function fullRangeLiquidityForAmounts(sqrtPriceX96, tickSpacing, amount0, amount1) {
  const { tickLower, tickUpper } = fullRangeTicks(tickSpacing)
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, amount0, amount1)
  return { liquidity, tickLower, tickUpper }
}

/** token0 amount represented by `liquidity` over [sqrtA, sqrtB] (sqrtA <= sqrtB). */
export function getAmount0Delta(sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sortSqrt(sqrtA, sqrtB)
  if (liquidity.isZero()) return BigNumber.from(0)
  return liquidity.mul(Q96).mul(hi.sub(lo)).div(hi.mul(lo))
}

/** token1 amount represented by `liquidity` over [sqrtA, sqrtB] (sqrtA <= sqrtB). */
export function getAmount1Delta(sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sortSqrt(sqrtA, sqrtB)
  if (liquidity.isZero()) return BigNumber.from(0)
  return mulDiv(liquidity, hi.sub(lo), Q96)
}

/** The token0/token1 amounts a position of `liquidity` over [sqrtA, sqrtB] holds at `sqrtPriceX96`. */
export function amountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sortSqrt(sqrtA, sqrtB)
  if (liquidity.isZero()) return { amount0: BigNumber.from(0), amount1: BigNumber.from(0) }
  if (sqrtPriceX96.lte(lo)) return { amount0: getAmount0Delta(lo, hi, liquidity), amount1: BigNumber.from(0) }
  if (sqrtPriceX96.lt(hi)) {
    return {
      amount0: getAmount0Delta(sqrtPriceX96, hi, liquidity),
      amount1: getAmount1Delta(lo, sqrtPriceX96, liquidity),
    }
  }
  return { amount0: BigNumber.from(0), amount1: getAmount1Delta(lo, hi, liquidity) }
}

/** The token0/token1 amounts a full-range position of `liquidity` holds at `sqrtPriceX96`. */
export function fullRangeAmountsForLiquidity(sqrtPriceX96, tickSpacing, liquidity) {
  const { tickLower, tickUpper } = fullRangeTicks(tickSpacing)
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  return amountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liquidity)
}
