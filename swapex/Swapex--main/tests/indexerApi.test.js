import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getHealth,
  getTokens,
  getToken,
  getPools,
  getPool,
  getPoolCandles,
  getPoolSwaps,
  getPositions,
  indexerConfigured,
  IndexError,
  fetchWithTimeout,
  isNotFound,
  indexerErrorMessage,
} from '../lib/indexerApi'
import { getFeatures } from '../lib/features'

const BASE = 'http://indexer.test'
const ADDR = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const ADDR2 = '0x0165878A594ca255338adfa4d48449f69242Eb8F'

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

const meta = (address, symbol = 'TKN') => ({ address, symbol, name: `${symbol} Token`, decimals: 18 })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('indexerConfigured', () => {
  it('is false for null/empty base URL, true otherwise', () => {
    expect(indexerConfigured(null)).toBe(false)
    expect(indexerConfigured('')).toBe(false)
    expect(indexerConfigured(BASE)).toBe(true)
  })
})

describe('getHealth', () => {
  it('returns null when no base URL is configured (not connected)', async () => {
    await expect(getHealth({ baseUrl: null })).resolves.toBeNull()
  })

  it('parses a valid health payload', async () => {
    const fetchImpl = fetchStub({ '/health': { ok: true, chainId: 31337, cursor: 12 } })
    await expect(getHealth({ baseUrl: BASE, fetchImpl })).resolves.toEqual({ ok: true, chainId: 31337, cursor: 12 })
  })

  it('throws IndexError on non-2xx', async () => {
    const fetchImpl = async () => jsonResponse({}, { status: 503 })
    await expect(getHealth({ baseUrl: BASE, fetchImpl })).rejects.toMatchObject({
      name: 'IndexerError',
      status: 503,
    })
  })

  it('throws IndexError on schema mismatch', async () => {
    const fetchImpl = fetchStub({ '/health': { ok: 'yes', chainId: 1, cursor: null } })
    await expect(getHealth({ baseUrl: BASE, fetchImpl })).rejects.toBeInstanceOf(IndexError)
  })

  it('throws IndexError on network failure', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(getHealth({ baseUrl: BASE, fetchImpl })).rejects.toBeInstanceOf(IndexError)
  })
})

describe('fetchWithTimeout', () => {
  it('aborts slow requests and rejects', async () => {
    const fetchImpl = (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    await expect(fetchWithTimeout(`${BASE}/slow`, { timeoutMs: 10, fetchImpl })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('getTokens / getToken', () => {
  it('returns the token list with USD prices', async () => {
    const tokens = { tokens: [{ ...meta(ADDR, 'tUSDC'), usdPrice: 1 }] }
    const fetchImpl = fetchStub({ '/tokens': tokens })
    await expect(getTokens({ baseUrl: BASE, fetchImpl })).resolves.toEqual(tokens.tokens)
  })

  it('rejects a token whose address is not an address', async () => {
    const fetchImpl = fetchStub({ [`/tokens/${ADDR}`]: { address: 'nope', symbol: 'X', name: 'X', decimals: 18, usdPrice: null } })
    await expect(getToken(ADDR, { baseUrl: BASE, fetchImpl })).rejects.toBeInstanceOf(IndexError)
  })
})

describe('getPools / getPool', () => {
  const pool = {
    address: ADDR,
    fee: 3000,
    token0: meta(ADDR),
    token1: meta(ADDR2, 'WETH'),
    price: 1080,
    sqrtPriceX96: '123',
    liquidity: '456',
    tick: 6985,
    volume24h: 3.5,
    fees24h: 0.0105,
    txCount24h: 3,
    change24h: 0.08,
    reserves0: 9,
    reserves1: 9720,
    tvlUsd: 19440,
  }

  it('passes pagination as query params and parses pools', async () => {
    const fetchImpl = fetchStub({ '/pools?limit=10&offset=5': { pools: [pool], total: 1 } })
    const result = await getPools({ limit: 10, offset: 5, baseUrl: BASE, fetchImpl })
    expect(result).toEqual({ pools: [pool], total: 1 })
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/pools?limit=10&offset=5`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('getPool parses one pool', async () => {
    const fetchImpl = fetchStub({ [`/pools/${ADDR}`]: pool })
    await expect(getPool(ADDR, { baseUrl: BASE, fetchImpl })).resolves.toEqual(pool)
  })

  it('getPool rejects a pool missing required fields', async () => {
    const fetchImpl = fetchStub({ [`/pools/${ADDR}`]: { address: ADDR, fee: 3000 } })
    await expect(getPool(ADDR, { baseUrl: BASE, fetchImpl })).rejects.toBeInstanceOf(IndexError)
  })
})

describe('getPoolCandles / getPoolSwaps', () => {
  it('encodes the interval and returns candles', async () => {
    const candle = { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }
    const fetchImpl = fetchStub({ [`/pools/${ADDR}/candles?interval=1D`]: { interval: '1D', candles: [candle] } })
    await expect(getPoolCandles(ADDR, '1D', { baseUrl: BASE, fetchImpl })).resolves.toEqual([candle])
  })

  it('returns swaps newest-first as parsed numbers', async () => {
    const swap = { txHash: '0xabc', timestamp: 100, amount0: 1, amount1: -1080, sqrtPriceX96: '99', tick: 1 }
    const fetchImpl = fetchStub({ [`/pools/${ADDR}/swaps?limit=25`]: { swaps: [swap] } })
    await expect(getPoolSwaps(ADDR, { limit: 25, baseUrl: BASE, fetchImpl })).resolves.toEqual([swap])
  })

  it('rejects a swap with a non-numeric amount (bad index data)', async () => {
    const fetchImpl = fetchStub({
      [`/pools/${ADDR}/swaps`]: { swaps: [{ txHash: '0x', timestamp: 1, amount0: 'lots', amount1: 0, sqrtPriceX96: '0', tick: 0 }] },
    })
    await expect(getPoolSwaps(ADDR, { baseUrl: BASE, fetchImpl })).rejects.toBeInstanceOf(IndexError)
  })
})

describe('getPositions', () => {
  it('parses position summaries', async () => {
    const pos = {
      tokenId: '7',
      owner: ADDR,
      liquidityAdded: '1000',
      liquidityRemoved: '0',
      feesCollected0Raw: '5',
      feesCollected1Raw: '6',
    }
    const fetchImpl = fetchStub({ [`/positions?owner=${ADDR}`]: { positions: [pos] } })
    await expect(getPositions(ADDR, { baseUrl: BASE, fetchImpl })).resolves.toEqual([pos])
  })
})

describe('getFeatures', () => {
  it('explore needs deployment + indexer, portfolio needs deployment', () => {
    expect(getFeatures({ hasDeployment: true, indexerAvailable: true })).toEqual({
      explore: true,
      portfolio: true,
      limit: false,
    })
    expect(getFeatures({ hasDeployment: true, indexerAvailable: false })).toEqual({
      explore: false,
      portfolio: true,
      limit: false,
    })
    expect(getFeatures({ hasDeployment: false, indexerAvailable: true })).toEqual({
      explore: false,
      portfolio: false,
      limit: false,
    })
  })
})

describe('isNotFound', () => {
  it('is true only for an HTTP 404 error', () => {
    expect(isNotFound(new IndexError('nope', { status: 404 }))).toBe(true)
    expect(isNotFound(new IndexError('nope', { status: 500 }))).toBe(false)
    expect(isNotFound(new IndexError('nope'))).toBe(false)
    expect(isNotFound(null)).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
  })
})

describe('indexerErrorMessage', () => {
  it('says the indexer may be down when there was no HTTP response', () => {
    expect(indexerErrorMessage(new IndexError('timeout'))).toMatch(/Could not reach the indexer/)
    expect(indexerErrorMessage(null)).toMatch(/Could not reach the indexer/)
  })
  it('names the HTTP status for real responses', () => {
    expect(indexerErrorMessage(new IndexError('x', { status: 500 }))).toContain('500')
    expect(indexerErrorMessage(new IndexError('x', { status: 400 }))).toContain('address')
    expect(indexerErrorMessage(new IndexError('x', { status: 429 }))).toMatch(/Too many requests/)
    expect(indexerErrorMessage(new IndexError('x', { status: 404 }))).toMatch(/not indexed/)
  })
})
