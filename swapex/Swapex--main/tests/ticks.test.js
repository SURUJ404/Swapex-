import { describe, it, expect } from 'vitest'
import {
  FEE_SPACING, MIN_TICK, MAX_TICK, usableRange, nearestUsableTick, tickToPrice, priceToTick,
  sqrtPriceX96ToTick, isInRange, tickSpacingFor, formatPrice,
} from '../lib/ticks'
import { amountsForDeposit, amountsForLiquidity, rangeStatus, toIntegerString } from '../lib/liquidity'

describe('ticks', () => {
  it('full range is a multiple of the spacing and inside the global bounds', () => {
    for (const s of Object.values(FEE_SPACING)) {
      const { min, max } = usableRange(s)
      expect(Math.abs(min % s)).toBe(0)
      expect(Math.abs(max % s)).toBe(0)
      expect(min).toBeGreaterThanOrEqual(MIN_TICK)
      expect(max).toBeLessThanOrEqual(MAX_TICK)
    }
    expect(usableRange(60)).toEqual({ min: -887220, max: 887220 }) // matches the contract tests
  })

  it('rounds to the nearest usable tick and clamps', () => {
    expect(nearestUsableTick(95, 60)).toBe(120)
    expect(nearestUsableTick(-95, 60)).toBe(-120)
    expect(nearestUsableTick(10_000_000, 60)).toBe(887220)
    expect(() => tickSpacingFor(1234)).toThrow()
  })

  it('price <-> tick round-trips within one tick, with decimals', () => {
    for (const [p, d0, d1] of [[3000, 18, 6], [1, 18, 18], [0.05, 18, 8], [60000, 8, 6]]) {
      const t = priceToTick(p, d0, d1)
      const back = tickToPrice(t, d0, d1)
      expect(Math.abs(back / p - 1)).toBeLessThan(0.0001)
    }
    expect(priceToTick(0, 18, 6)).toBeNull()
    expect(priceToTick(NaN, 18, 6)).toBeNull()
  })

  it('reads the current tick from sqrtPriceX96', () => {
    expect(sqrtPriceX96ToTick(String(2 ** 96))).toBe(0)
    expect(isInRange(5, 0, 10)).toBe(true)
    expect(isInRange(10, 0, 10)).toBe(false) // upper edge is exclusive, like the pool
  })

  it('formats prices', () => {
    expect(formatPrice(3000)).toBe('3,000')
    expect(formatPrice(Infinity)).toBe('∞')
    expect(formatPrice(0.00012346)).toBe('0.0001235')
  })
})

describe('liquidity amounts', () => {
  const sqrt1 = 1 // price 1.0

  it('needs both tokens inside the range and the amounts balance', () => {
    const r = amountsForDeposit(sqrt1, -600, 600, { token: 0, amount: 1e18 })
    expect(r.amount0).toBeCloseTo(1e18, -3)
    expect(r.amount1).toBeGreaterThan(0)
    // depositing the computed token1 amount back gives the same liquidity
    const r2 = amountsForDeposit(sqrt1, -600, 600, { token: 1, amount: r.amount1 })
    expect(Math.abs(r2.liquidity / r.liquidity - 1)).toBeLessThan(1e-9)
  })

  it('is single-sided outside the range', () => {
    expect(rangeStatus(-1000, -600, 600)).toBe('token0')
    expect(rangeStatus(1000, -600, 600)).toBe('token1')
    expect(rangeStatus(0, -600, 600)).toBe('both')
    // price below the range: only token0 can be deposited
    const below = amountsForDeposit(Math.sqrt(1.0001 ** -1000), -600, 600, { token: 0, amount: 1e18 })
    expect(below.amount1).toBe(0)
    expect(amountsForDeposit(Math.sqrt(1.0001 ** -1000), -600, 600, { token: 1, amount: 1e18 })).toBeNull()
  })

  it('position value is consistent with the deposit', () => {
    const r = amountsForDeposit(sqrt1, -6000, 6000, { token: 0, amount: 5e17 })
    const v = amountsForLiquidity(sqrt1, -6000, 6000, r.liquidity)
    expect(Math.abs(v.amount0 / r.amount0 - 1)).toBeLessThan(1e-9)
    expect(Math.abs(v.amount1 / r.amount1 - 1)).toBeLessThan(1e-9)
  })

  it('converts to safe integer strings', () => {
    expect(toIntegerString(1e21)).toBe('1000000000000000000000')
    expect(toIntegerString(12.9)).toBe('12')
    expect(() => toIntegerString(-1)).toThrow()
    expect(() => toIntegerString(NaN)).toThrow()
  })
})
