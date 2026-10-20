// How much of each token a range needs. Mirrors LiquidityAmounts.sol in floating point, in raw token units.
// Use it to fill in the second amount of a deposit and to compute slippage minimums.
// It is an estimate: the contract recomputes exactly and reverts if the real amounts fall below the minimums.
import { tickToRawPrice } from './ticks'

const sqrtAt = (tick) => Math.sqrt(tickToRawPrice(tick))

/** Which tokens a range needs at the current tick: 'both' | 'token0' | 'token1'. */
export function rangeStatus(currentTick, tickLower, tickUpper) {
  if (currentTick < tickLower) return 'token0'
  if (currentTick >= tickUpper) return 'token1'
  return 'both'
}

/**
 * Given a deposit of one token, return the amount of the other the range needs (raw units, as Numbers).
 * sqrtPrice is the CURRENT price as a plain sqrt (sqrtPriceX96 / 2^96).
 * input: { token: 0 | 1, amount }
 */
export function amountsForDeposit(sqrtPrice, tickLower, tickUpper, input) {
  const sa = sqrtAt(tickLower)
  const sb = sqrtAt(tickUpper)
  const sp = Math.min(Math.max(sqrtPrice, sa), sb) // clamp into the range
  const a = input.amount
  let liquidity
  if (input.token === 0) {
    if (sp >= sb) return null // price is above the range: token0 cannot be deposited
    liquidity = (a * sp * sb) / (sb - sp)
  } else {
    if (sp <= sa) return null // price is below the range: token1 cannot be deposited
    liquidity = a / (sp - sa)
  }
  if (!(liquidity > 0) || !Number.isFinite(liquidity)) return null
  return {
    liquidity,
    amount0: (liquidity * (sb - sp)) / (sp * sb),
    amount1: liquidity * (sp - sa),
  }
}

/** Liquidity -> token amounts at the current price (what a position is worth now). */
export function amountsForLiquidity(sqrtPrice, tickLower, tickUpper, liquidity) {
  const sa = sqrtAt(tickLower)
  const sb = sqrtAt(tickUpper)
  const sp = Math.min(Math.max(sqrtPrice, sa), sb)
  return {
    amount0: (liquidity * (sb - sp)) / (sp * sb),
    amount1: liquidity * (sp - sa),
  }
}

/** Number (raw units, non-negative) -> integer decimal string safe for BigInt(). */
export function toIntegerString(x) {
  if (!Number.isFinite(x) || x < 0) throw new Error('Invalid amount')
  return BigInt(Math.floor(x)).toString()
}
