import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDb, insertEvents, recordBlock, type Db } from '../src/db'
import { buildServer } from '../src/api/server'
import type { Manifest } from '../src/deployment'
import type { TokenMeta } from '../src/aggregate/prices'
import type { StoredEvent } from '../src/db'

const Q96 = 2n ** 96n
const NOW = Math.floor(Date.now() / 1000)

const ADDR = {
  usdc: '0x00000000000000000000000000000000000000a1',
  dai: '0x00000000000000000000000000000000000000a2',
  weth: '0x00000000000000000000000000000000000000a3',
  poolDaiUsdc: '0x00000000000000000000000000000000000000b1',
  poolWethDai: '0x00000000000000000000000000000000000000b2',
  factory: '0x00000000000000000000000000000000000000f1',
  pm: '0x00000000000000000000000000000000000000f2',
  alice: '0x00000000000000000000000000000000000000aa',
  zero: '0x0000000000000000000000000000000000000000',
}

const MANIFEST: Manifest = {
  chainId: 31337,
  blockNumber: 0,
  factory: ADDR.factory,
  positionManager: ADDR.pm,
  tokens: [
    { address: ADDR.usdc, symbol: 'tUSDC', name: 'Test USD Coin', decimals: 6 },
    { address: ADDR.dai, symbol: 'tDAI', name: 'Test Dai', decimals: 18 },
    { address: ADDR.weth, symbol: 'tWETH', name: 'Test Wrapped Ether', decimals: 18 },
  ],
}

const META: Record<string, TokenMeta> = {
  [ADDR.usdc]: { address: ADDR.usdc, symbol: 'tUSDC', name: 'Test USD Coin', decimals: 6 },
  [ADDR.dai]: { address: ADDR.dai, symbol: 'tDAI', name: 'Test Dai', decimals: 18 },
  [ADDR.weth]: { address: ADDR.weth, symbol: 'tWETH', name: 'Test Wrapped Ether', decimals: 18 },
}
const metaProvider = async (address: string): Promise<TokenMeta> => {
  const m = META[address.toLowerCase()]
  if (!m) throw new Error(`no meta for ${address}`)
  return m
}

function sqrtForPrice(price: number, decimals0: number, decimals1: number): bigint {
  const raw = price * 10 ** (decimals1 - decimals0)
  return (BigInt(Math.round(Math.sqrt(raw) * 1e9)) * Q96) / BigInt(1e9)
}

function ev(
  overrides: Omit<Partial<StoredEvent>, 'args'> & {
    event: string
    args: Record<string, unknown>
    blockNumber: number
  }
): StoredEvent {
  return {
    logId: `${overrides.event}:${overrides.blockNumber}:${overrides.logIndex ?? 0}`,
    blockNumber: overrides.blockNumber,
    blockHash: '0x' + '11'.repeat(32),
    txHash: '0x' + overrides.blockNumber.toString(16).padStart(64, '0'),
    logIndex: overrides.logIndex ?? 0,
    address: overrides.address ?? ADDR.poolWethDai,
    event: overrides.event,
    args: JSON.stringify(
      Object.fromEntries(
        Object.entries(overrides.args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
      )
    ),
  }
}

function seed(db: Db): void {
  // blocks with timestamps: 2h ago, 25h ago, now
  recordBlock(db, { number: 1, hash: '0x' + '01'.repeat(32), parentHash: '0x', timestamp: NOW - 90000 })
  recordBlock(db, { number: 2, hash: '0x' + '02'.repeat(32), parentHash: '0x', timestamp: NOW - 7200 })
  recordBlock(db, { number: 3, hash: '0x' + '03'.repeat(32), parentHash: '0x', timestamp: NOW - 60 })

  // pools: DAI/USDC reference pool at $1 per DAI; WETH/DAI for trades
  db.prepare(
    'INSERT INTO pools (address, token0, token1, fee, tick_spacing, created_block) VALUES (?,?,?,?,?,?)'
  ).run(ADDR.poolDaiUsdc, ADDR.dai, ADDR.usdc, 500, 10, 1)
  db.prepare(
    'INSERT INTO pools (address, token0, token1, fee, tick_spacing, created_block) VALUES (?,?,?,?,?,?)'
  ).run(ADDR.poolWethDai, ADDR.weth, ADDR.dai, 3000, 60, 1)

  const wethDaiSwaps: StoredEvent[] = [
    // 25h ago: price 1000 DAI/WETH, 1 WETH traded (outside 24h window)
    ev({
      event: 'Swap',
      blockNumber: 1,
      args: {
        sender: ADDR.alice,
        recipient: ADDR.alice,
        amount0: 10n ** 18n,
        amount1: -1000n * 10n ** 18n,
        sqrtPriceX96: sqrtForPrice(1000, 18, 18),
        liquidity: '5000000000000000000',
        tick: 6931,
      },
    }),
    // 2h ago: price 1100, 2 WETH
    ev({
      event: 'Swap',
      blockNumber: 2,
      logIndex: 0,
      args: {
        sender: ADDR.alice,
        recipient: ADDR.alice,
        amount0: 2n * 10n ** 18n,
        amount1: -2200n * 10n ** 18n,
        sqrtPriceX96: sqrtForPrice(1100, 18, 18),
        liquidity: '5000000000000000000',
        tick: 7003,
      },
    }),
    // 2h ago, later: price 1050, 0.5 WETH
    ev({
      event: 'Swap',
      blockNumber: 2,
      logIndex: 1,
      args: {
        sender: ADDR.alice,
        recipient: ADDR.alice,
        amount0: 5n * 10n ** 17n,
        amount1: -525n * 10n ** 18n,
        sqrtPriceX96: sqrtForPrice(1050, 18, 18),
        liquidity: '5000000000000000000',
        tick: 6956,
      },
    }),
    // now: price 1080, 1 WETH
    ev({
      event: 'Swap',
      blockNumber: 3,
      args: {
        sender: ADDR.alice,
        recipient: ADDR.alice,
        amount0: 10n ** 18n,
        amount1: -1080n * 10n ** 18n,
        sqrtPriceX96: sqrtForPrice(1080, 18, 18),
        liquidity: '5000000000000000000',
        tick: 6985,
      },
    }),
    // reference pool swap at $1
    ev({
      event: 'Swap',
      blockNumber: 3,
      address: ADDR.poolDaiUsdc,
      args: {
        sender: ADDR.alice,
        recipient: ADDR.alice,
        amount0: 10n ** 18n,
        amount1: -1000000n,
        sqrtPriceX96: sqrtForPrice(1, 18, 6),
        liquidity: '1000000',
        tick: 0,
      },
    }),
  ]

  // reserves: mint 10 WETH + 10800 DAI, collect 1 WETH + 1080 DAI
  const reserves: StoredEvent[] = [
    ev({
      event: 'Mint',
      blockNumber: 2,
      logIndex: 5,
      args: { sender: ADDR.pm, owner: ADDR.pm, tickLower: -60, tickUpper: 60, amount: 1n, amount0: 10n * 10n ** 18n, amount1: 10800n * 10n ** 18n },
    }),
    ev({
      event: 'Collect',
      blockNumber: 3,
      logIndex: 5,
      args: { owner: ADDR.pm, recipient: ADDR.alice, tickLower: -60, tickUpper: 60, amount0: 10n ** 18n, amount1: 1080n * 10n ** 18n },
    }),
  ]

  // position #7 minted to alice, some liquidity + fees collected
  const positions: StoredEvent[] = [
    ev({
      event: 'Transfer',
      blockNumber: 2,
      address: ADDR.pm,
      args: { from: ADDR.zero, to: ADDR.alice, tokenId: 7n },
    }),
    ev({
      event: 'IncreaseLiquidity',
      blockNumber: 2,
      address: ADDR.pm,
      args: { tokenId: 7n, liquidity: 1000n, amount0: 1n, amount1: 2n },
    }),
    ev({
      event: 'Collect',
      blockNumber: 3,
      address: ADDR.pm,
      args: { tokenId: 7n, recipient: ADDR.alice, amount0: 5n, amount1: 6n },
    }),
  ]

  insertEvents(db, [...wethDaiSwaps, ...reserves, ...positions])
}

describe('api', () => {
  let db: Db
  let app: Awaited<ReturnType<typeof buildServer>>

  beforeAll(async () => {
    db = openDb(':memory:')
    seed(db)
    app = await buildServer({
      db,
      manifest: MANIFEST,
      chainId: 31337,
      corsOrigins: ['http://localhost:3000'],
      meta: metaProvider,
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, chainId: 31337, cursor: null })
  })

  it('GET /pools lists pools with 24h stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/pools' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { pools: Record<string, unknown>[]; total: number }
    expect(body.total).toBe(2)
    const weth = body.pools.find((p) => p.address === ADDR.poolWethDai)!
    // 24h window excludes the 25h-old swap: 2 + 0.5 + 1 = 3.5 WETH
    expect(weth.volume24h).toBeCloseTo(3.5, 8)
    expect(weth.txCount24h).toBe(3)
    expect(weth.price).toBeCloseTo(1080, 2)
    // reserves = 10-1 = 9 WETH, 10800-1080 = 9720 DAI; DAI = $1, WETH price from pool = 1080
    expect(weth.tvlUsd).toBeCloseTo(9 * 1080 + 9720, 4)
    expect(weth.change24h).toBeCloseTo((1080 - 1000) / 1000, 3)
  })

  it('GET /pools/:address 404s unknown and 400s bad address', async () => {
    const unknown = await app.inject({ method: 'GET', url: `/pools/${ADDR.zero}` })
    expect(unknown.statusCode).toBe(404)
    const bad = await app.inject({ method: 'GET', url: '/pools/not-an-address' })
    expect(bad.statusCode).toBe(400)
  })

  it('GET /pools/:address/candles builds OHLCV and validates interval', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/pools/${ADDR.poolWethDai}/candles?interval=1H`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { interval: string; candles: { time: number; open: number; close: number }[] }
    expect(body.interval).toBe('1H')
    // buckets: 25h ago (excluded? no — candles include all time), 2h ago, now
    expect(body.candles.length).toBe(3)
    const last = body.candles[2]!
    expect(last.close).toBeCloseTo(1080, 2)

    const bad = await app.inject({ method: 'GET', url: `/pools/${ADDR.poolWethDai}/candles?interval=5M` })
    expect(bad.statusCode).toBe(400)
  })

  it('GET /pools/:address/swaps paginates newest-first', async () => {
    const res = await app.inject({ method: 'GET', url: `/pools/${ADDR.poolWethDai}/swaps?limit=2` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { swaps: { amount0: number }[] }
    expect(body.swaps.length).toBe(2)
    expect(body.swaps[0]!.amount0).toBeCloseTo(1, 8) // newest first: 1 WETH
    expect(body.swaps[1]!.amount0).toBeCloseTo(0.5, 8)
  })

  it('GET /tokens includes USD prices from the reference rule', async () => {
    const res = await app.inject({ method: 'GET', url: '/tokens' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { tokens: { symbol: string; usdPrice: number | null }[] }
    const usdc = body.tokens.find((t) => t.symbol === 'tUSDC')!
    const dai = body.tokens.find((t) => t.symbol === 'tDAI')!
    expect(usdc.usdPrice).toBe(1)
    expect(dai.usdPrice).toBeCloseTo(1, 6)
    const weth = body.tokens.find((t) => t.symbol === 'tWETH')!
    expect(weth.usdPrice).toBeCloseTo(1080, 2)
  })

  it('GET /positions returns owned positions with ledger sums', async () => {
    const res = await app.inject({ method: 'GET', url: `/positions?owner=${ADDR.alice}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { positions: { tokenId: string; liquidityAdded: string; feesCollected0Raw: string }[] }
    expect(body.positions.length).toBe(1)
    expect(body.positions[0]!.tokenId).toBe('7')
    expect(body.positions[0]!.liquidityAdded).toBe('1000')
    expect(body.positions[0]!.feesCollected0Raw).toBe('5')
  })

  it('GET /positions rejects a bad owner', async () => {
    const res = await app.inject({ method: 'GET', url: '/positions?owner=nope' })
    expect(res.statusCode).toBe(400)
  })

  it('CORS allowlist echoes allowed origin, not *', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
  })
})
