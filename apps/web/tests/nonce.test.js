import { describe, it, expect } from 'vitest'
import { lowestFreeBit, findFreeNonce } from '../lib/nonce'

const FULL = (1n << 256n) - 1n

describe('lowestFreeBit', () => {
  it('is 0 for an empty word', () => expect(lowestFreeBit(0n)).toBe(0))
  it('skips set low bits', () => expect(lowestFreeBit(0b0111n)).toBe(3))
  it('finds a gap, not just the top', () => expect(lowestFreeBit(0b1011n)).toBe(2))
  it('is -1 when all 256 bits are set', () => expect(lowestFreeBit(FULL)).toBe(-1))
  it('accepts decimal / BigNumber-like input', () => {
    expect(lowestFreeBit('7')).toBe(3)
    expect(lowestFreeBit({ toString: () => '1' })).toBe(1)
  })
})

describe('findFreeNonce', () => {
  it('is 0 for a fresh owner', async () => {
    expect(await findFreeNonce(async () => 0n)).toBe(0)
  })
  it('moves to the next word once the first is full (the old 1024 cap is gone)', async () => {
    const words = [FULL, FULL, FULL, FULL, FULL, 0b1n]
    expect(await findFreeNonce(async (i) => words[i] ?? 0n)).toBe(5 * 256 + 1)
  })
  it('reads one word per 256 nonces', async () => {
    let calls = 0
    await findFreeNonce(async (i) => { calls++; return i < 3 ? FULL : 0n })
    expect(calls).toBe(4)
  })
  it('throws when every scanned word is full', async () => {
    await expect(findFreeNonce(async () => FULL, 2)).rejects.toThrow(/no free permit nonce/)
  })
})
