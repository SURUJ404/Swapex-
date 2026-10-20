import { describe, it, expect } from 'vitest'
import { parseUnits, parseGwei } from 'viem'
import { formatRate, impactPercent, needsExtraConfirm, feeEstimateWei, feeEstimateEth } from '../lib/review'

describe('formatRate', () => {
  it('formats a 1:1 rate across equal decimals', () => {
    const one = parseUnits('1', 18)
    expect(formatRate(one, 18, one, 18)).toBe('1')
  })

  it('scales across different decimals (18 -> 6)', () => {
    const inAmt = parseUnits('2', 18)
    const outAmt = parseUnits('10', 6) // 10 USDC per 2 TOKEN => 5 per 1
    expect(formatRate(inAmt, 18, outAmt, 6)).toBe('5')
  })

  it('keeps fractional precision', () => {
    const inAmt = parseUnits('3', 18)
    const outAmt = parseUnits('10', 18)
    expect(formatRate(inAmt, 18, outAmt, 18)).toBe('3.33333333')
  })

  it('returns null for zero or missing inputs', () => {
    expect(formatRate(0n, 18, 1n, 18)).toBeNull()
    expect(formatRate(null, 18, 1n, 18)).toBeNull()
    expect(formatRate(1n, 18, null, 18)).toBeNull()
  })
})

describe('impactPercent', () => {
  it('renders a percentage to two decimals', () => {
    expect(impactPercent(0.0523)).toBe('5.23%')
    expect(impactPercent(0)).toBe('0.00%')
  })

  it('renders n/a for null or non-finite', () => {
    expect(impactPercent(null)).toBe('n/a')
    expect(impactPercent(undefined)).toBe('n/a')
    expect(impactPercent(NaN)).toBe('n/a')
  })
})

describe('needsExtraConfirm', () => {
  it('is true at or above 5%', () => {
    expect(needsExtraConfirm(0.05)).toBe(true)
    expect(needsExtraConfirm(0.07)).toBe(true)
  })

  it('is false below 5% or unknown', () => {
    expect(needsExtraConfirm(0.049)).toBe(false)
    expect(needsExtraConfirm(0)).toBe(false)
    expect(needsExtraConfirm(null)).toBe(false)
  })
})

describe('feeEstimate', () => {
  it('multiplies gasEstimate by gasPrice', () => {
    const gas = 150000n
    const price = parseGwei('1')
    expect(feeEstimateWei(gas, price).toString()).toBe(parseUnits('0.00015', 18).toString())
  })

  it('formats as a short ETH string', () => {
    const gas = 21000n
    const price = parseGwei('10')
    expect(feeEstimateEth(gas, price)).toBe('0.00021')
  })

  it('returns null when either side is missing or invalid', () => {
    expect(feeEstimateWei(null, 1n)).toBeNull()
    expect(feeEstimateWei(1n, null)).toBeNull()
    expect(feeEstimateWei('not-a-number', 1n)).toBeNull()
    expect(feeEstimateEth(null, 1n)).toBeNull()
  })
})
