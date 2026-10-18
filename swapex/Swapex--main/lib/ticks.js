// Tick and price helpers for concentrated-liquidity ranges. Pure Number math: it drives the UI and the
// slippage bounds only. The contracts do the exact integer math and enforce the minimums on-chain.

export const FEE_SPACING = { 500: 10, 3000: 60, 10000: 200 }
export const MIN_TICK = -887272
export const MAX_TICK = 887272

export function tickSpacingFor(fee) {
  const s = FEE_SPACING[fee]
  if (!s) throw new Error(`Unknown fee tier: ${fee}`)
  return s
}

/** Smallest and largest usable ticks for a spacing (the "full range"). */
export function usableRange(spacing) {
  return {
    min: Math.ceil(MIN_TICK / spacing) * spacing || 0,
    max: Math.floor(MAX_TICK / spacing) * spacing || 0,
  }
}

export function nearestUsableTick(tick, spacing) {
  const { min, max } = usableRange(spacing)
  const rounded = Math.round(tick / spacing) * spacing
  return Math.min(max, Math.max(min, rounded)) || 0 // `|| 0` turns -0 into 0
}

/** Raw price (token1 raw units per token0 raw unit) at a tick. */
export function tickToRawPrice(tick) {
  return Math.pow(1.0001, tick)
}

/** Human price (token1 per token0, in whole tokens) at a tick. */
export function tickToPrice(tick, decimals0, decimals1) {
  return tickToRawPrice(tick) * Math.pow(10, decimals0 - decimals1)
}

/** Tick for a human price (token1 per token0). Returns null for invalid input. */
export function priceToTick(price, decimals0, decimals1) {
  if (!Number.isFinite(price) || price <= 0) return null
  const raw = price * Math.pow(10, decimals1 - decimals0)
  const tick = Math.log(raw) / Math.log(1.0001)
  if (!Number.isFinite(tick)) return null
  return Math.min(MAX_TICK, Math.max(MIN_TICK, Math.round(tick)))
}

/** Current tick from a sqrtPriceX96 given as a decimal string (Number precision is enough for display). */
export function sqrtPriceX96ToTick(sqrtPriceX96) {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96
  return Math.floor(Math.log(sqrt * sqrt) / Math.log(1.0001))
}

export function isInRange(currentTick, tickLower, tickUpper) {
  return currentTick >= tickLower && currentTick < tickUpper
}

/** "1,234.5", "0.00001234", "∞" for display of a range edge. */
export function formatPrice(p) {
  if (p == null || Number.isNaN(p)) return '—'
  if (!Number.isFinite(p) || p > 1e30) return '∞'
  if (p === 0 || p < 1e-30) return '0'
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (p >= 1) return p.toPrecision(6).replace(/\.?0+$/, '')
  return p.toPrecision(4)
}

const MIN_SQRT_RATIO = 4295128739n
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

/** sqrtPriceX96 (decimal string) for a human price token1-per-token0. Null if out of the pool's bounds. */
export function priceToSqrtPriceX96(price, decimals0, decimals1) {
  if (!Number.isFinite(price) || price <= 0) return null
  const raw = price * Math.pow(10, decimals1 - decimals0)
  const x = Math.sqrt(raw) * 2 ** 96
  if (!Number.isFinite(x)) return null
  const v = BigInt(Math.floor(x))
  if (v <= MIN_SQRT_RATIO || v >= MAX_SQRT_RATIO) return null
  return v.toString()
}
