import { describe, it, expect } from 'vitest'
import {
  parseAmount,
  minAfterSlippage,
  maxAfterSlippage,
  percentToBps,
  quote,
  deadlineFromNow,
  formatAmount,
  priceImpact,
} from '../lib/amounts'
import { parseError } from '../lib/errors'

describe('parseAmount', () => {
  it('parses plain and fractional values', () => {
    expect(parseAmount('1', 18).toString()).toBe('1000000000000000000')
    expect(parseAmount('1.5', 6).toString()).toBe('1500000')
    expect(parseAmount('.5', 6).toString()).toBe('500000')
  })
  it('truncates extra decimals instead of throwing', () => {
    expect(parseAmount('1.1234567', 6).toString()).toBe('1123456')
  })
  it('rejects empty, zero, negative and junk', () => {
    for (const v of ['', '.', '0', '0.0', '-1', '1e5', 'abc', '1.2.3', null, undefined]) {
      expect(parseAmount(v, 18)).toBeNull()
    }
  })
})

describe('slippage', () => {
  it('uses integer basis-point math', () => {
    expect(minAfterSlippage(10000n, 50)).toBe(9950n)
    expect(minAfterSlippage(10000n, 10)).toBe(9990n) // 0.1% used to crash
    expect(maxAfterSlippage(10000n, 50)).toBe(10050n)
  })
  it('rejects invalid bps', () => {
    expect(() => minAfterSlippage(1n, 0.5)).toThrow()
    expect(() => minAfterSlippage(1n, -1)).toThrow()
    expect(() => minAfterSlippage(1n, 10001)).toThrow()
  })
  it('converts percent text to bps with a cap', () => {
    expect(percentToBps('0.5')).toBe(50)
    expect(percentToBps('1')).toBe(100)
    expect(percentToBps('0.1')).toBe(10)
    expect(percentToBps('51')).toBeNull()
    expect(percentToBps('abc')).toBeNull()
    expect(percentToBps('-1')).toBeNull()
  })
})

describe('quote', () => {
  it('matches UniswapV2Library.quote', () => {
    expect(quote(100n, 1000n, 2000n)).toBe(200n)
    expect(quote(0n, 1000n, 2000n)).toBeNull()
    expect(quote(5n, 0n, 2000n)).toBeNull()
  })
})

describe('misc', () => {
  it('computes deadlines in unix seconds', () => {
    expect(deadlineFromNow(20, 1_000_000_000_000)).toBe(1_000_000_000 + 1200)
    expect(deadlineFromNow(NaN, 1_000_000_000_000)).toBe(1_000_000_000 + 1200)
  })
  it('formats base units', () => {
    expect(formatAmount(1500000n, 6)).toBe('1.5')
    expect(formatAmount(1000000n, 6)).toBe('1')
  })
  it('price impact excludes the 0.3% fee', () => {
    // 1 token in, pool 1:1 with huge reserves -> out ~ 0.997 -> impact ~ 0
    const big = 10n ** 24n
    const out = 997000000000000000n
    const impact = priceImpact(10n ** 18n, out, [{ reserveIn: big, reserveOut: big }], 18, 18)
    expect(impact).toBeLessThan(0.0001)
  })
})

describe('parseError', () => {
  it('maps wallet rejection and router reverts to readable text', () => {
    expect(parseError({ code: 4001 })).toMatch(/rejected/i)
    expect(parseError({ message: 'execution reverted: UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT' })).toMatch(/slippage/i)
    expect(parseError({ message: 'UniswapV2Router: EXPIRED' })).toMatch(/deadline/i)
  })
})
