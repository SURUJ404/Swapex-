import { describe, it, expect } from 'vitest'
import { loadImportedTokens, saveImportedToken, isImported } from '../lib/importedTokens'
import { searchTokens } from '../lib/tokens'

const CHAIN = 31337
const A = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const B = '0x0165878A594ca255338adfa4d48449f69242Eb8F'

function mockStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  }
}

const token = (address, symbol = 'FOO', decimals = 18) => ({
  address,
  symbol,
  name: `${symbol} Token`,
  decimals,
})

describe('loadImportedTokens', () => {
  it('returns [] with no storage or empty storage', () => {
    expect(loadImportedTokens(CHAIN, null)).toEqual([])
    expect(loadImportedTokens(CHAIN, mockStorage())).toEqual([])
  })

  it('returns [] for corrupt JSON or a non-array', () => {
    const s = mockStorage()
    s.setItem(`swapex:imported-tokens:${CHAIN}`, '{nope')
    expect(loadImportedTokens(CHAIN, s)).toEqual([])
    s.setItem(`swapex:imported-tokens:${CHAIN}`, '{"a":1}')
    expect(loadImportedTokens(CHAIN, s)).toEqual([])
  })

  it('drops malformed entries but keeps valid ones', () => {
    const s = mockStorage()
    s.setItem(
      `swapex:imported-tokens:${CHAIN}`,
      JSON.stringify([token(A), { address: 'not-an-address', symbol: 'X', name: 'X', decimals: 18 }, token(B, 'BAR', 6)])
    )
    const list = loadImportedTokens(CHAIN, s)
    expect(list.map((t) => t.symbol)).toEqual(['FOO', 'BAR'])
  })
})

describe('saveImportedToken', () => {
  it('round-trips through storage', () => {
    const s = mockStorage()
    saveImportedToken(token(A), CHAIN, s)
    expect(loadImportedTokens(CHAIN, s).map((t) => t.address)).toEqual([A])
  })

  it('upserts by address case-insensitively (no duplicates)', () => {
    const s = mockStorage()
    saveImportedToken(token(A, 'FOO'), CHAIN, s)
    saveImportedToken(token(A.toLowerCase(), 'FOO2', 6), CHAIN, s)
    const list = loadImportedTokens(CHAIN, s)
    expect(list.length).toBe(1)
    expect(list[0].symbol).toBe('FOO2')
    expect(list[0].decimals).toBe(6)
  })

  it('rejects invalid tokens and leaves storage unchanged', () => {
    const s = mockStorage()
    saveImportedToken({ address: '0x123', symbol: 'X', name: 'X', decimals: 18 }, CHAIN, s)
    saveImportedToken(token(A, 'OK', 999), CHAIN, s) // decimals out of range
    expect(loadImportedTokens(CHAIN, s)).toEqual([])
  })

  it('caps the list at 50 entries', () => {
    const s = mockStorage()
    for (let i = 0; i < 60; i++) {
      const addr = '0x' + String(i).padStart(40, 'a')
      saveImportedToken(token(addr, `T${i}`), CHAIN, s)
    }
    expect(loadImportedTokens(CHAIN, s).length).toBe(50)
    expect(loadImportedTokens(CHAIN, s)[0].symbol).toBe('T59') // newest first
  })

  it('does not throw without storage', () => {
    expect(() => saveImportedToken(token(A), CHAIN, null)).not.toThrow()
  })
})

describe('isImported', () => {
  it('matches case-insensitively and returns false for unknown', () => {
    const s = mockStorage()
    saveImportedToken(token(A), CHAIN, s)
    expect(isImported(A.toLowerCase(), CHAIN, s)).toBe(true)
    expect(isImported(B, CHAIN, s)).toBe(false)
    expect(isImported(null, CHAIN, s)).toBe(false)
  })
})

describe('searchTokens', () => {
  it('matches by symbol, name and exact address', () => {
    const s = mockStorage()
    saveImportedToken(token(A, 'unicoin', 18), CHAIN, s) // deliberately not a real brand
    expect(searchTokens('unicoin', CHAIN, s).map((t) => t.address)).toContain(A)
    expect(searchTokens('unicoin token', CHAIN, s).map((t) => t.address)).toContain(A)
    expect(searchTokens(A.toLowerCase(), CHAIN, s).map((t) => t.address)).toContain(A)
  })

  it('does not match partial addresses', () => {
    const s = mockStorage()
    saveImportedToken(token(A), CHAIN, s)
    expect(searchTokens(A.slice(0, 10), CHAIN, s).map((t) => t.address)).not.toContain(A)
  })

  it('empty query returns imported tokens (base list is chain-configured)', () => {
    const s = mockStorage()
    saveImportedToken(token(A), CHAIN, s)
    const all = searchTokens('', CHAIN, s)
    expect(all.map((t) => t.address)).toContain(A)
  })
})
