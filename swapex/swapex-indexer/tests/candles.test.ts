import { describe, it, expect } from 'vitest'
import { buildCandles, priceOf } from '../src/aggregate/candles'

const Q96 = 2n ** 96n

/** sqrtPriceX96 for a human price (token1 per token0) with given decimals. */
function sqrtForPrice(price: number, decimals0: number, decimals1: number): bigint {
  const raw = price * 10 ** (decimals1 - decimals0)
  return BigInt(Math.round(Math.sqrt(raw) * 1e9)) * Q96 / BigInt(1e9)
}

describe('priceOf', () => {
  it('adjusts for token decimals', () => {
    // price 1 human, 6 vs 18 decimals
    const sqrt = sqrtForPrice(1, 6, 18)
    expect(priceOf(sqrt, 6, 18)).toBeCloseTo(1, 8)
  })

  it('inverts with swapped orientation', () => {
    const sqrt = sqrtForPrice(2, 18, 18)
    expect(priceOf(sqrt, 18, 18)).toBeCloseTo(2, 8)
    expect(priceOf(sqrt, 18, 18)).toBeCloseTo(2, 8)
  })
})

describe('buildCandles', () => {
  const T0 = 1_699_999_200 // aligned hour

  it('returns empty for no swaps', () => {
    expect(buildCandles([], '1H', 18, 18)).toEqual([])
  })

  it('builds OHLCV per hourly bucket, order-independent', () => {
    const swaps = [
      { timestamp: T0 + 100, sqrtPriceX96: sqrtForPrice(10, 18, 18), amount0: 1_000_000_000_000_000_000n },
      { timestamp: T0 + 200, sqrtPriceX96: sqrtForPrice(12, 18, 18), amount0: 500_000_000_000_000_000n },
      { timestamp: T0 + 300, sqrtPriceX96: sqrtForPrice(9, 18, 18), amount0: 250_000_000_000_000_000n },
      { timestamp: T0 + 3700, sqrtPriceX96: sqrtForPrice(11, 18, 18), amount0: 100_000_000_000_000_000n },
    ]
    const candles = buildCandles(swaps, '1H', 18, 18)
    expect(candles.length).toBe(2)

    const [c1, c2] = candles
    expect(c1!.time).toBe(T0)
    expect(c1!.open).toBeCloseTo(10, 6)
    expect(c1!.high).toBeCloseTo(12, 6)
    expect(c1!.low).toBeCloseTo(9, 6)
    expect(c1!.close).toBeCloseTo(9, 6)
    expect(c1!.volume).toBeCloseTo(1.75, 6)

    expect(c2!.time).toBe(T0 + 3600)
    expect(c2!.open).toBeCloseTo(11, 6)
    expect(c2!.volume).toBeCloseTo(0.1, 6)
  })

  it('daily buckets group across hours', () => {
    const swaps = [
      { timestamp: T0, sqrtPriceX96: sqrtForPrice(1, 18, 18), amount0: 1n },
      { timestamp: T0 + 86400, sqrtPriceX96: sqrtForPrice(2, 18, 18), amount0: 1n },
    ]
    const candles = buildCandles(swaps, '1D', 18, 18)
    expect(candles.length).toBe(2)
    expect(candles[1]!.open).toBeCloseTo(2, 6)
  })
})
