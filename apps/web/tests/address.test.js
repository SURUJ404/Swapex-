import { describe, it, expect } from 'vitest'
import { utils } from 'ethers'
import { checkAddress } from '../lib/address'

// Official EIP-55 checksum vectors (EIP-55 appendix)
const EIP55 = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
]

describe('checkAddress — EIP-55 validation', () => {
  it('accepts every official checksummed vector unchanged', () => {
    for (const addr of EIP55) {
      const r = checkAddress(addr)
      expect(r.ok, addr).toBe(true)
      expect(r.normalized, addr).toBe(addr)
      expect(r.warning, addr).toBeNull()
    }
  })

  it('accepts all-lowercase and normalizes to the checksummed form (no warning)', () => {
    const lower = EIP55[0].toLowerCase()
    const r = checkAddress(lower)
    expect(r.ok).toBe(true)
    expect(r.normalized).toBe(EIP55[0])
    expect(r.mixedCase).toBe(false)
    expect(r.warning).toBeNull()
  })

  it('accepts all-uppercase (legacy form) and normalizes', () => {
    const upper = '0x' + EIP55[0].slice(2).toUpperCase()
    const r = checkAddress(upper)
    expect(r.ok).toBe(true)
    expect(r.normalized).toBe(EIP55[0])
    expect(r.mixedCase).toBe(false)
  })

  it('rejects a mixed-case address with a bad checksum and says so (the phish tripwire)', () => {
    // flip the case of exactly one letter — the classic paste-tamper scenario
    const addr = EIP55[0]
    const tampered = addr.slice(0, 4) + (addr[4] === addr[4].toLowerCase() ? addr[4].toUpperCase() : addr[4].toLowerCase()) + addr.slice(5)
    const r = checkAddress(tampered)
    expect(r.ok).toBe(false)
    expect(r.mixedCase).toBe(true)
    expect(r.normalized).toBeNull()
    expect(r.warning).toMatch(/EIP-55/)
    expect(r.warning).toMatch(/altered/)
  })

  it('rejects malformed inputs', () => {
    for (const bad of ['', '0x1234', '0x' + 'g'.repeat(40), '0x' + 'a'.repeat(39), 'vitalik.eth', null, undefined, 42]) {
      const r = checkAddress(bad)
      expect(r.ok, String(bad)).toBe(false)
      expect(r.normalized).toBeNull()
      expect(r.warning).toBeTruthy()
    }
  })

  it('normalized output always round-trips through ethers getAddress', () => {
    const r = checkAddress(EIP55[1].toLowerCase())
    expect(utils.getAddress(r.normalized)).toBe(r.normalized)
  })
})
