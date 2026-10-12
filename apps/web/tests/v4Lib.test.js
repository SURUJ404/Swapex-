import { describe, it, expect } from 'vitest'
import { BigNumber, utils } from 'ethers'
import { getSqrtRatioAtTick, fullRangeTicks, MIN_TICK, MAX_TICK } from '../lib/tickMath'
import {
  getLiquidityForAmounts,
  fullRangeLiquidityForAmounts,
  fullRangeAmountsForLiquidity,
  getAmount0Delta,
  getAmount1Delta,
} from '../lib/liquidity'
import { isqrt, priceToSqrtPriceX96 } from '../lib/price'
import { toCurrencyAddress, sortCurrencies, buildPoolKey, isZeroForOne } from '../lib/pool'
import { NATIVE_ADDRESS, ZERO_ADDRESS, POOL_FEE, POOL_TICK_SPACING } from '../constants'

const Q96 = BigNumber.from(2).pow(96)

describe('getSqrtRatioAtTick', () => {
  it('matches the known anchors', () => {
    expect(getSqrtRatioAtTick(0).toString()).toBe(Q96.toString())
    expect(getSqrtRatioAtTick(MIN_TICK).toString()).toBe('4295128739')
    expect(getSqrtRatioAtTick(MAX_TICK).toString()).toBe(
      '1461446703485210103287273052203988822378723970342'
    )
  })
  it('is strictly increasing and symmetric around zero', () => {
    expect(getSqrtRatioAtTick(-60).lt(getSqrtRatioAtTick(0))).toBe(true)
    expect(getSqrtRatioAtTick(0).lt(getSqrtRatioAtTick(60))).toBe(true)
    // reciprocal symmetry: price(-t) == 2^192 / price(t)
    const up = getSqrtRatioAtTick(120)
    const down = getSqrtRatioAtTick(-120)
    expect(down.mul(up).div(Q96).toString()).toBe(Q96.toString())
  })
  it('rejects out-of-range ticks', () => {
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow()
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow()
    expect(() => getSqrtRatioAtTick(1.5)).toThrow()
  })
})

describe('fullRangeTicks', () => {
  it('returns the widest spacing-aligned ticks inside bounds', () => {
    const { tickLower, tickUpper } = fullRangeTicks(60)
    expect(tickLower).toBe(-887220)
    expect(tickUpper).toBe(887220)
    expect(tickLower % 60 === 0).toBe(true) // boolean form: avoids Object.is(-0, 0) === false
    expect(tickUpper % 60 === 0).toBe(true)
    expect(tickLower).toBeGreaterThanOrEqual(MIN_TICK)
    expect(tickUpper).toBeLessThanOrEqual(MAX_TICK)
  })
})

describe('liquidity math', () => {
  it('round-trips amounts -> liquidity -> amounts at 1:1 full range', () => {
    const e18 = utils.parseEther('1')
    const { liquidity } = fullRangeLiquidityForAmounts(Q96, 60, e18, e18)
    expect(liquidity.gt(0)).toBe(true)
    const { amount0, amount1 } = fullRangeAmountsForLiquidity(Q96, 60, liquidity)
    // deposit and withdrawal agree within pool-favouring rounding dust (direction is not fixed)
    const dust = utils.parseEther('0.001')
    expect(amount0.sub(e18).abs().lt(dust)).toBe(true)
    expect(amount1.sub(e18).abs().lt(dust)).toBe(true)
  })
  it('is limited by the smaller side when amounts are unbalanced', () => {
    const sqrtA = getSqrtRatioAtTick(fullRangeTicks(60).tickLower)
    const sqrtB = getSqrtRatioAtTick(fullRangeTicks(60).tickUpper)
    const sqrtP = Q96
    const huge = utils.parseEther('1000')
    const tiny = utils.parseEther('1')
    const balanced = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, huge, huge)
    const unbalanced = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, huge, tiny)
    expect(unbalanced.gt(0)).toBe(true)
    expect(unbalanced.lt(balanced)).toBe(true)
  })
  it('getAmount0Delta and getAmount1Delta are positive over a range', () => {
    const sqrtA = getSqrtRatioAtTick(-60000)
    const sqrtB = getSqrtRatioAtTick(60000)
    const e18 = utils.parseEther('1')
    expect(getAmount0Delta(sqrtA, sqrtB, e18).gt(0)).toBe(true)
    expect(getAmount1Delta(sqrtA, sqrtB, e18).gt(0)).toBe(true)
    expect(getAmount0Delta(sqrtA, sqrtB, BigNumber.from(0)).isZero()).toBe(true)
  })
})

describe('price helpers', () => {
  it('isqrt floors to the nearest integer square root', () => {
    expect(isqrt(0n)).toBe(0n)
    expect(isqrt(1n)).toBe(1n)
    expect(isqrt(2n)).toBe(1n)
    expect(isqrt(15n)).toBe(3n)
    expect(isqrt(16n)).toBe(4n)
  })
  it('maps a human price to the Q96 sqrt price', () => {
    expect(priceToSqrtPriceX96('1', 18, 18).toString()).toBe(Q96.toString())
    expect(priceToSqrtPriceX96('4', 18, 18).toString()).toBe(Q96.mul(2).toString())
    expect(priceToSqrtPriceX96('0.25', 18, 18).toString()).toBe(Q96.div(2).toString())
  })
  it('scales the price by the decimals difference', () => {
    // token1 with 6 more decimals than token0 at the same human price -> raw price 1e6x -> sqrt 1e3x
    const base = priceToSqrtPriceX96('1', 18, 18)
    const scaled = priceToSqrtPriceX96('1', 18, 24)
    expect(scaled.toString()).toBe(base.mul(1000).toString())
  })
})

describe('pool key helpers', () => {
  it('maps native to the zero address and sorts currencies', () => {
    expect(toCurrencyAddress({ address: NATIVE_ADDRESS })).toBe(ZERO_ADDRESS)
    const [c0, c1] = sortCurrencies('0xBBB', '0xAAA')
    expect(c0).toBe('0xAAA')
    expect(c1).toBe('0xBBB')
  })
  it('builds a sorted, fee-tiered pool key', () => {
    const a = { address: '0xBBB', symbol: 'B', decimals: 18 }
    const b = { address: NATIVE_ADDRESS, symbol: 'ETH', decimals: 18 }
    const key = buildPoolKey(a, b)
    expect(key.currency0).toBe(ZERO_ADDRESS) // native is smallest
    expect(key.currency1).toBe('0xBBB')
    expect(key.fee).toBe(POOL_FEE)
    expect(key.tickSpacing).toBe(POOL_TICK_SPACING)
  })
  it('detects the zeroForOne side of a swap', () => {
    const key = buildPoolKey(
      { address: NATIVE_ADDRESS, symbol: 'ETH', decimals: 18 },
      { address: '0xBBB', symbol: 'B', decimals: 18 }
    )
    expect(isZeroForOne(key, { address: NATIVE_ADDRESS })).toBe(true)
    expect(isZeroForOne(key, { address: '0xBBB' })).toBe(false)
  })
})
