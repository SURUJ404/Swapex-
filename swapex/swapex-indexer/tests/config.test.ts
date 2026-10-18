import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config'

const base = { CHAIN_ID: '31337', RPC_URL: 'http://127.0.0.1:8545' }

describe('loadConfig', () => {
  it('applies defaults and parses origins', () => {
    const c = loadConfig({ ...base, CORS_ORIGINS: 'http://a.com, http://b.com' })
    expect(c.PORT).toBe(4000)
    expect(c.CORS_ORIGINS).toEqual(['http://a.com', 'http://b.com'])
  })
  it('refuses a wildcard CORS origin', () => {
    expect(() => loadConfig({ ...base, CORS_ORIGINS: '*' })).toThrow()
  })
  it('rejects a bad RPC url or chain id', () => {
    expect(() => loadConfig({ ...base, RPC_URL: 'nope' })).toThrow()
    expect(() => loadConfig({ ...base, CHAIN_ID: '-1' })).toThrow()
  })
})
