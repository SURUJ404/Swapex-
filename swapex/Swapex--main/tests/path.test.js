import { describe, it, expect } from 'vitest'
import { encodePath, encodePathReversed, decodePath } from '../lib/path'

const WETH = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const USDC = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const DAI = '0x0165878A594ca255338adfa4d48449f69242Eb8F'

describe('encodePath', () => {
  it('packs token | fee | token exactly like the router expects (vector from the on-chain e2e run)', () => {
    expect(encodePath([WETH, USDC], [3000])).toBe(
      '0x5fbdb2315678afecb367f032d93f642f64180aa3000bb85fc8d32690cc91d4c39d9d3abcbd16989f875707'
    )
  })

  it('handles multiple hops and every fee tier', () => {
    const p = encodePath([WETH, USDC, DAI], [500, 10000])
    expect(p.length).toBe(2 + 40 + 6 + 40 + 6 + 40)
    expect(decodePath(p)).toEqual({
      tokens: [WETH, USDC, DAI].map((t) => t.toLowerCase()),
      fees: [500, 10000],
    })
  })

  it('reverses hops for exact-output paths', () => {
    const rev = decodePath(encodePathReversed([WETH, USDC, DAI], [500, 3000]))
    expect(rev.tokens).toEqual([DAI, USDC, WETH].map((t) => t.toLowerCase()))
    expect(rev.fees).toEqual([3000, 500])
  })

  it('rejects malformed input', () => {
    expect(() => encodePath([WETH], [])).toThrow()
    expect(() => encodePath([WETH, USDC], [])).toThrow()
    expect(() => encodePath([WETH, 'nope'], [3000])).toThrow()
    expect(() => encodePath([WETH, USDC], [0])).toThrow()
    expect(() => encodePath([WETH, USDC], [0x1000000])).toThrow()
    expect(() => encodePath([WETH, USDC, DAI, WETH, USDC, DAI], [1, 2, 3, 4, 5])).toThrow() // > 4 hops
  })
})

describe('decodePath', () => {
  it('rejects bad hex and bad lengths', () => {
    expect(() => decodePath('0x1234')).toThrow()
    expect(() => decodePath('nothex')).toThrow()
    expect(() => decodePath(encodePath([WETH, USDC], [3000]) + 'ab')).toThrow()
  })
})
