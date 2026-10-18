import { describe, it, expect, vi, afterEach } from 'vitest'
import { isAddressLike, parsePairQuery, decideTextRoute, resolveRoute } from '../lib/navSearch'

const BASE = 'http://indexer.test'
const ADDR = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const POOL_ADDR = '0x1111111111111111111111111111111111111111'

const meta = (address, symbol, name) => ({ address, symbol, name, decimals: 18 })
const token = (address, symbol, name) => ({ ...meta(address, symbol, name), usdPrice: 1 })
const pool = (address, fee, s0, s1) => ({
  address,
  fee,
  token0: meta(ADDR, s0, `${s0} Token`),
  token1: meta(POOL_ADDR, s1, `${s1} Token`),
  price: 1,
  sqrtPriceX96: '1',
  liquidity: '1',
  tick: 0,
  volume24h: 0,
  fees24h: 0,
  txCount24h: 0,
  change24h: null,
  reserves0: 0,
  reserves1: 0,
  tvlUsd: 0,
})

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function fetchStub(routes) {
  return vi.fn(async (url) => {
    const path = url.replace(BASE, '')
    const hit = routes[path]
    if (!hit) return jsonResponse({ error: 'not found' }, { status: 404 })
    return jsonResponse(hit)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isAddressLike', () => {
  it('accepts 0x + 40 hex, rejects anything else', () => {
    expect(isAddressLike(ADDR)).toBe(true)
    expect(isAddressLike(ADDR.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isAddressLike('weth')).toBe(false)
    expect(isAddressLike(`0x${'a'.repeat(39)}`)).toBe(false)
    expect(isAddressLike(`0x${'g'.repeat(40)}`)).toBe(false)
    expect(isAddressLike('')).toBe(false)
    expect(isAddressLike(null)).toBe(false)
  })
})

describe('parsePairQuery', () => {
  it('splits two symbol parts, tolerant of whitespace and case', () => {
    expect(parsePairQuery('WETH/tusdc')).toEqual(['weth', 'tusdc'])
    expect(parsePairQuery('weth - tusdc')).toEqual(['weth', 'tusdc'])
    expect(parsePairQuery('  WETH /  TUSDC ')).toEqual(['weth', 'tusdc'])
  })

  it('rejects single or three-part queries', () => {
    expect(parsePairQuery('weth')).toBeNull()
    expect(parsePairQuery('a/b/c')).toBeNull()
    expect(parsePairQuery('')).toBeNull()
  })
})

describe('decideTextRoute', () => {
  const tokens = [
    token('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'WETH', 'Wrapped Ether'),
    token('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'TUSDC', 'Test USDC'),
  ]
  const pools = [
    pool(POOL_ADDR, 3000, 'WETH', 'TUSDC'),
    pool('0x2222222222222222222222222222222222222222', 500, 'WETH', 'TUSDC'),
  ]

  it('exact symbol match -> that token detail', () => {
    expect(decideTextRoute('weth', { tokens, pools })).toEqual({
      pathname: '/explore/tokens/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(decideTextRoute('TUSDC', { tokens, pools })).toEqual({
      pathname: '/explore/tokens/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
  })

  it('unique pool pair -> that pool detail', () => {
    const single = pool(POOL_ADDR, 3000, 'WETH', 'TUSDC')
    expect(decideTextRoute('weth/tusdc', { tokens, pools: [single] })).toEqual({ pathname: `/explore/pools/${POOL_ADDR}` })
    // order-insensitive
    expect(decideTextRoute('tusdc/weth', { tokens, pools: [single] })).toEqual({ pathname: `/explore/pools/${POOL_ADDR}` })
  })

  it('ambiguous pair (two fee tiers) -> filtered list, not a guess', () => {
    expect(decideTextRoute('weth/tusdc', { tokens, pools })).toEqual({ pathname: '/explore', query: { q: 'weth/tusdc' } })
  })

  it('unknown query -> filtered list with the query preserved', () => {
    expect(decideTextRoute('dai', { tokens, pools })).toEqual({ pathname: '/explore', query: { q: 'dai' } })
    expect(decideTextRoute('', { tokens, pools })).toEqual({ pathname: '/explore', query: { q: '' } })
  })

  it('duplicate symbols in the list -> filtered list, not a random pick', () => {
    const dupes = [tokens[0], token('0xcccccccccccccccccccccccccccccccccccccccc', 'WETH', 'Other WETH')]
    expect(decideTextRoute('weth', { tokens: dupes, pools })).toEqual({ pathname: '/explore', query: { q: 'weth' } })
  })
})

describe('resolveRoute', () => {
  it('empty query -> null (no navigation)', async () => {
    await expect(resolveRoute('', { baseUrl: BASE })).resolves.toBeNull()
    await expect(resolveRoute('   ', { baseUrl: BASE })).resolves.toBeNull()
    await expect(resolveRoute(null, { baseUrl: BASE })).resolves.toBeNull()
  })

  it('indexer not configured -> filtered list (page shows not-connected honestly)', async () => {
    await expect(resolveRoute('weth', { baseUrl: null })).resolves.toEqual({ pathname: '/explore', query: { q: 'weth' } })
    await expect(resolveRoute(ADDR, { baseUrl: null })).resolves.toEqual({ pathname: '/explore', query: { q: ADDR } })
  })

  it('address indexed as a token -> token detail', async () => {
    const fetchImpl = fetchStub({ [`/tokens/${ADDR}`]: token(ADDR, 'WETH', 'Wrapped Ether') })
    await expect(resolveRoute(ADDR, { baseUrl: BASE, fetchImpl })).resolves.toEqual({
      pathname: `/explore/tokens/${ADDR}`,
    })
  })

  it('address not a token but a pool -> pool detail', async () => {
    const fetchImpl = fetchStub({ [`/pools/${ADDR}`]: pool(POOL_ADDR, 3000, 'WETH', 'TUSDC') })
    await expect(resolveRoute(ADDR, { baseUrl: BASE, fetchImpl })).resolves.toEqual({
      pathname: `/explore/pools/${ADDR}`,
    })
  })

  it('address indexed as neither -> filtered list', async () => {
    const fetchImpl = fetchStub({})
    await expect(resolveRoute(ADDR, { baseUrl: BASE, fetchImpl })).resolves.toEqual({
      pathname: '/explore',
      query: { q: ADDR },
    })
  })

  it('symbol query -> token detail via list lookup', async () => {
    const fetchImpl = fetchStub({
      '/tokens': { tokens: [token(ADDR, 'WETH', 'Wrapped Ether')] },
      '/pools?limit=100': { pools: [], total: 0 },
    })
    await expect(resolveRoute('weth', { baseUrl: BASE, fetchImpl })).resolves.toEqual({
      pathname: `/explore/tokens/${ADDR}`,
    })
  })

  it('transport failure rethrows (caller routes to the list page error path)', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(resolveRoute('weth', { baseUrl: BASE, fetchImpl })).rejects.toThrow()
  })

  it('HTTP error other than 404 rethrows instead of mis-routing', async () => {
    const fetchImpl = async () => jsonResponse({}, { status: 503 })
    await expect(resolveRoute(ADDR, { baseUrl: BASE, fetchImpl })).rejects.toMatchObject({ status: 503 })
  })
})
