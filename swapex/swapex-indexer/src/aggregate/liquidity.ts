// Token amounts for a liquidity value at the current price — a floating-point
// mirror of LiquidityAmounts math, in raw token units. Estimates only: the
// contract recomputes exactly. Ported from the web app's lib/liquidity.js.

export function tickToRawPrice(tick: number): number {
  return 1.0001 ** tick
}

const sqrtAt = (tick: number): number => Math.sqrt(tickToRawPrice(tick))

/** Liquidity -> token amounts at the current price (what a position is worth now). */
export function amountsForLiquidity(
  sqrtPrice: number,
  tickLower: number,
  tickUpper: number,
  liquidity: number
): { amount0: number; amount1: number } {
  const sa = sqrtAt(tickLower)
  const sb = sqrtAt(tickUpper)
  const sp = Math.min(Math.max(sqrtPrice, sa), sb)
  return {
    amount0: (liquidity * (sb - sp)) / (sp * sb),
    amount1: liquidity * (sp - sa),
  }
}

/** Plain sqrt of a Q64.96 price: sqrtPriceX96 / 2^96. */
export function sqrtFromX96(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / 2 ** 96
}
