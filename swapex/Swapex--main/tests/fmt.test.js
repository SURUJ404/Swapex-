import { describe, it, expect } from 'vitest'
import { formatUsd, formatCompact, formatPct, shortAddress, formatTime } from '../lib/fmt'

describe('formatUsd', () => {
  it('formats with cents and groups thousands', () => {
    expect(formatUsd(2955.7837)).toBe('$2,955.78')
    expect(formatUsd(199708.171, 0)).toBe('$199,708')
  })
  it('keeps sub-cent prices instead of showing $0', () => {
    expect(formatUsd(0.000042)).toBe('$0.000042')
  })
  it('renders an honest dash for null/NaN', () => {
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(undefined)).toBe('—')
    expect(formatUsd(NaN)).toBe('—')
  })
})

describe('formatCompact', () => {
  it('uses K/M/B suffixes', () => {
    expect(formatCompact(1_200_000)).toBe('1.2M')
    expect(formatCompact(34_500)).toBe('34.5K')
    expect(formatCompact(2_500_000_000)).toBe('2.5B')
  })
  it('keeps small volumes instead of rounding them to 0', () => {
    expect(formatCompact(0.001338)).toBe('0.00134')
    expect(formatCompact(-0.0003386)).toBe('-0.000339')
  })
  it('renders an honest dash for null', () => {
    expect(formatCompact(null)).toBe('—')
  })
})

describe('formatPct', () => {
  it('signs positive changes and keeps negatives', () => {
    expect(formatPct(0.082)).toBe('+8.2%')
    expect(formatPct(-0.03)).toBe('-3%')
    expect(formatPct(0)).toBe('0%')
  })
  it('renders an honest dash for null', () => {
    expect(formatPct(null)).toBe('—')
  })
})

describe('shortAddress', () => {
  it('trims the middle', () => {
    expect(shortAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3')).toBe('0x5fbd…0aa3')
    expect(shortAddress('')).toBe('—')
    expect(shortAddress(null)).toBe('—')
  })
})

describe('formatTime', () => {
  it('formats unix seconds and dashes null', () => {
    expect(formatTime(1792338166)).toContain('2026')
    expect(formatTime(null)).toBe('—')
    expect(formatTime(NaN)).toBe('—')
  })
})
