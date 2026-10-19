// Limit-order API + aggregation tests: submit-time verification (EIP-712, ERC-1271,
// chain-state checks), storage semantics, and event-derived fill/cancel state.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  encodeAbiParameters,
  encodeEventTopics,
  hashTypedData,
  parseAbi,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { deleteEventsAfter, insertEvents, insertOrder, openDb, type Db, type StoredEvent } from '../src/db'
import { buildServer } from '../src/api/server'
import { LIMIT_ORDER_EVENTS } from '../src/abis'
import { decodeLogs } from '../src/decode'
import { ERC1271_MAGIC, ORDER_TYPES, orderDomain, type OrderMessage } from '../src/eip712'
import { decorateOrder, listOrders } from '../src/aggregate/orders'
import type { Manifest } from '../src/deployment'
import type { TokenMeta } from '../src/aggregate/prices'
import type { FastifyInstance } from 'fastify'

const NOW = Math.floor(Date.now() / 1000)
const CHAIN_ID = 31337
const LIMIT = '0x00000000000000000000000000000000000000c1'

const ADDR = {
  dai: '0x00000000000000000000000000000000000000a1',
  weth: '0x00000000000000000000000000000000000000a2',
  usdc: '0x00000000000000000000000000000000000000a3',
  poolDaiWeth: '0x00000000000000000000000000000000000000b1', // dai/weth fee 3000
  poolDaiWeth500: '0x00000000000000000000000000000000000000b3', // dai/weth fee 500 (second tier for fee-conflict)
  poolDaiUsdc: '0x00000000000000000000000000000000000000b2', // dai/usdc fee 500
  factory: '0x00000000000000000000000000000000000000f1',
  pm: '0x00000000000000000000000000000000000000f2',
}

// well-known throwaway test keys (hardhat/anvil style), never real funds
const MAKER = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001')
const OTHER = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002')

const MANIFEST: Manifest = {
  chainId: CHAIN_ID,
  blockNumber: 0,
  factory: ADDR.factory,
  positionManager: ADDR.pm,
  limitOrders: LIMIT,
  tokens: [],
}

const meta = async (address: string): Promise<TokenMeta> => {
  throw new Error(`no meta for ${address}`)
}

function orderMessage(over: Partial<OrderMessage> = {}): OrderMessage {
  return {
    maker: MAKER.address,
    tokenIn: ADDR.dai as `0x${string}`,
    tokenOut: ADDR.weth as `0x${string}`,
    amountIn: 1000n,
    minAmountOut: 1n,
    expiry: BigInt(NOW + 3600),
    nonce: 1n,
    receiver: MAKER.address,
    ...over,
  }
}

function domainFor(chainId = CHAIN_ID, contract = LIMIT) {
  return orderDomain(chainId, contract as `0x${string}`)
}

async function signOrder(o: OrderMessage, signer = MAKER, chainId = CHAIN_ID, contract = LIMIT): Promise<string> {
  return signer.signTypedData({
    domain: domainFor(chainId, contract),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: o,
  })
}

async function postBody(
  app: FastifyInstance,
  payload: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'POST', url: '/orders', payload: payload as object })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}

/** Full POST payload for a message, signed by the given signer. */
async function postOrder(
  app: FastifyInstance,
  over: Partial<OrderMessage> = {},
  opts: { fee?: number; signer?: typeof MAKER; chainId?: number } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const o = orderMessage(over)
  const signature = await signOrder(o, opts.signer ?? MAKER, opts.chainId ?? CHAIN_ID)
  return postBody(app, {
    order: {
      maker: o.maker,
      tokenIn: o.tokenIn,
      tokenOut: o.tokenOut,
      amountIn: o.amountIn.toString(),
      minAmountOut: o.minAmountOut.toString(),
      expiry: o.expiry.toString(),
      nonce: o.nonce.toString(),
      receiver: o.receiver,
    },
    signature,
    fee: opts.fee ?? 3000,
  })
}

function stubClient(over: {
  bytecode?: string
  orders?: readonly [bigint, bigint]
  cancelled?: boolean
  magic?: string
  rpcDown?: boolean
}): PublicClient {
  return {
    getBytecode: async () => over.bytecode ?? '0x',
    readContract: async (args: { functionName: string }) => {
      if (over.rpcDown) throw new Error('rpc down')
      if (args.functionName === 'orders') return over.orders ?? [0n, 0n]
      if (args.functionName === 'cancelled') return over.cancelled ?? false
      if (args.functionName === 'isValidSignature') return over.magic ?? ERC1271_MAGIC
      throw new Error(`unexpected readContract ${args.functionName}`)
    },
  } as unknown as PublicClient
}

function ev(event: string, args: Record<string, unknown>, blockNumber: number, logIndex = 0): StoredEvent {
  return {
    logId: `${event}:${blockNumber}:${logIndex}`,
    blockNumber,
    blockHash: '0x' + '11'.repeat(32),
    txHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    logIndex,
    address: LIMIT,
    event,
    args: JSON.stringify(
      Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))
    ),
  }
}

function seedPools(db: Db): void {
  db.prepare(
    'INSERT INTO pools (address, token0, token1, fee, tick_spacing, created_block) VALUES (?,?,?,?,?,?)'
  ).run(ADDR.poolDaiWeth, ADDR.weth, ADDR.dai, 3000, 60, 1)
  db.prepare(
    'INSERT INTO pools (address, token0, token1, fee, tick_spacing, created_block) VALUES (?,?,?,?,?,?)'
  ).run(ADDR.poolDaiWeth500, ADDR.weth, ADDR.dai, 500, 10, 1)
  db.prepare(
    'INSERT INTO pools (address, token0, token1, fee, tick_spacing, created_block) VALUES (?,?,?,?,?,?)'
  ).run(ADDR.poolDaiUsdc, ADDR.dai, ADDR.usdc, 500, 10, 1)
}

interface Harness {
  db: Db
  app: FastifyInstance
}

async function makeApp(over: { manifest?: Manifest; client?: PublicClient } = {}): Promise<Harness> {
  const db = openDb(':memory:')
  seedPools(db)
  const app = await buildServer({
    db,
    manifest: over.manifest ?? MANIFEST,
    chainId: CHAIN_ID,
    corsOrigins: ['http://localhost:3000'],
    meta,
    client: over.client,
  })
  return { db, app }
}

const harnesses: Harness[] = []
async function harness(over: { manifest?: Manifest; client?: PublicClient } = {}): Promise<Harness> {
  const h = await makeApp(over)
  harnesses.push(h)
  return h
}

afterAll(async () => {
  for (const h of harnesses) {
    await h.app.close()
    h.db.close()
  }
})

// ---------------------------------------------------------------- POST /orders

describe('POST /orders', () => {
  it('accepts a valid EOA order and returns the canonical EIP-712 hash', async () => {
    const { app } = await harness()
    const o = orderMessage({ nonce: 11n })
    const res = await postOrder(app, { nonce: 11n })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('accepted')
    expect(res.body.checked).toBe('eoa')
    const expected = hashTypedData({ domain: domainFor(), types: ORDER_TYPES, primaryType: 'Order', message: o })
    expect(res.body.orderHash).toBe(expected)
  })

  it('treats a re-submit of the same order as a duplicate, not an error', async () => {
    const { app } = await harness()
    const first = await postOrder(app, { nonce: 12n })
    const again = await postOrder(app, { nonce: 12n })
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body.status).toBe('duplicate')
    expect(again.body.orderHash).toBe(first.body.orderHash)
  })

  it('rejects the same payload resubmitted under a different fee tier', async () => {
    const { app } = await harness()
    const first = await postOrder(app, { nonce: 13n }, { fee: 3000 })
    const conflict = await postOrder(app, { nonce: 13n }, { fee: 500 })
    expect(first.status).toBe(201)
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toContain('fee tier')
  })

  it('rejects a signature from the wrong key', async () => {
    const { app } = await harness()
    const res = await postOrder(app, { nonce: 14n }, { signer: OTHER })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid signature')
  })

  it('rejects a signature made for another chain or contract (domain is re-checked)', async () => {
    const { app } = await harness()
    const wrongChain = await postOrder(app, { nonce: 15n }, { chainId: 1 })
    expect(wrongChain.status).toBe(400)
    const wrongContract = await postOrder(
      app,
      { nonce: 15n },
      {}
    )
    // sanity: the same message on the right domain is fine
    expect(wrongContract.status).toBe(201)
    const wrongVerify = await postBody(app, {
      order: {
        maker: MAKER.address,
        tokenIn: ADDR.dai,
        tokenOut: ADDR.weth,
        amountIn: '1000',
        minAmountOut: '1',
        expiry: String(NOW + 3600),
        nonce: '16',
        receiver: MAKER.address,
      },
      signature: await signOrder(orderMessage({ nonce: 16n }), MAKER, CHAIN_ID, '0x00000000000000000000000000000000000000ff'),
      fee: 3000,
    })
    expect(wrongVerify.status).toBe(400)
    expect(wrongVerify.body.error).toBe('invalid signature')
  })

  it('rejects expired orders, zero amounts and self-pairs before touching signatures', async () => {
    const { app } = await harness()
    const expired = await postOrder(app, { nonce: 17n, expiry: BigInt(NOW - 100) })
    expect(expired.status).toBe(400)
    expect(expired.body.error).toContain('expired')

    const zeroIn = await postOrder(app, { nonce: 17n, amountIn: 0n })
    expect(zeroIn.status).toBe(400)
    const zeroOut = await postOrder(app, { nonce: 17n, minAmountOut: 0n })
    expect(zeroOut.status).toBe(400)

    const selfPair = await postOrder(app, { nonce: 17n, tokenOut: ADDR.dai as `0x${string}` })
    expect(selfPair.status).toBe(400)
    expect(selfPair.body.error).toContain('differ')
  })

  it('rejects orders with no pool for that pair and fee tier', async () => {
    const { app } = await harness()
    const noPoolFee = await postOrder(app, { nonce: 18n }, { fee: 100 }) // dai/weth has 3000 and 500 only
    expect(noPoolFee.status).toBe(400)
    expect(noPoolFee.body.error).toContain('no pool')
    const noPoolPair = await postOrder(app, { nonce: 18n, tokenIn: ADDR.usdc as `0x${string}` }, { fee: 3000 })
    expect(noPoolPair.status).toBe(400)
  })

  it('rejects malformed payloads with a clear 400', async () => {
    const { app } = await harness()
    const missing = await postBody(app, { maker: MAKER.address })
    expect(missing.status).toBe(400)
    const shortSig = await postBody(app, {
      order: {
        maker: MAKER.address,
        tokenIn: ADDR.dai,
        tokenOut: ADDR.weth,
        amountIn: '1000',
        minAmountOut: '1',
        expiry: String(NOW + 3600),
        nonce: '19',
        receiver: MAKER.address,
      },
      signature: '0x' + 'ab'.repeat(64),
      fee: 3000,
    })
    expect(shortSig.status).toBe(400)
  })

  it('reports 503 when the chain has no limit-orders contract', async () => {
    const { limitOrders, ...rest } = MANIFEST
    const { app } = await harness({ manifest: rest })
    const res = await postOrder(app, { nonce: 20n })
    expect(res.status).toBe(503)
    expect(res.body.error).toContain('not deployed')
  })

  it('verifies contract makers through ERC-1271 when a client is wired', async () => {
    const walletMaker = '0x00000000000000000000000000000000000000aa'
    const { app } = await harness({ client: stubClient({ bytecode: '0x6080', magic: ERC1271_MAGIC }) })
    const o = orderMessage({ maker: walletMaker as `0x${string}`, nonce: 21n })
    // signature is NOT the wallet's EOA key - only the 1271 path can accept it
    const signature = await signOrder(o, OTHER)
    const res = await postBody(app, {
      order: {
        maker: o.maker,
        tokenIn: o.tokenIn,
        tokenOut: o.tokenOut,
        amountIn: '1000',
        minAmountOut: '1',
        expiry: String(NOW + 3600),
        nonce: '21',
        receiver: o.receiver,
      },
      signature,
      fee: 3000,
    })
    expect(res.status).toBe(201)
    expect(res.body.checked).toBe('erc1271')

    const badMagic = await harness({ client: stubClient({ bytecode: '0x6080', magic: '0xdeadbeef' }) })
    const res2 = await postBody(badMagic.app, {
      order: { ...o, expiry: String(NOW + 3600), nonce: '22', amountIn: '1000', minAmountOut: '1' },
      signature,
      fee: 3000,
    })
    expect(res2.status).toBe(400)
    expect(res2.body.error).toBe('invalid signature')
  })

  it('keeps rejecting bad EOA signatures when the maker is a plain account (no bytecode)', async () => {
    const { app } = await harness({ client: stubClient({ bytecode: '0x' }) })
    const res = await postOrder(app, { nonce: 23n }, { signer: OTHER })
    expect(res.status).toBe(400)
  })

  it('refuses orders the chain says are already filled or cancelled', async () => {
    const filledClient = await harness({
      client: stubClient({ orders: [1000n, 5n] as readonly [bigint, bigint] }),
    })
    const filled = await postOrder(filledClient.app, { nonce: 24n })
    expect(filled.status).toBe(409)
    expect(filled.body.error).toContain('already filled')

    const cancelledClient = await harness({ client: stubClient({ cancelled: true }) })
    const cancelled = await postOrder(cancelledClient.app, { nonce: 25n })
    expect(cancelled.status).toBe(409)
    expect(cancelled.body.error).toContain('cancelled')
  })

  it('answers 502 rather than storing an order when chain state cannot be read', async () => {
    const { app } = await harness({ client: stubClient({ rpcDown: true }) })
    const res = await postOrder(app, { nonce: 26n })
    expect(res.status).toBe(502)
  })

  it('accepts a valid order through the full chain-checking path', async () => {
    const { app } = await harness({ client: stubClient({ orders: [0n, 0n], cancelled: false }) })
    const res = await postOrder(app, { nonce: 27n })
    expect(res.status).toBe(201)
    expect(res.body.checked).toBe('eoa')
  })
})

// ---------------------------------------------------------------- GET /orders

describe('GET /orders', () => {
  /** stored order, inserted directly; returns its EIP-712 hash */
  function store(db: Db, over: { nonce: bigint; amountIn?: bigint; expiry?: number; maker?: string }): string {
    const o = orderMessage({
      nonce: over.nonce,
      amountIn: over.amountIn ?? 1000n,
      expiry: BigInt(over.expiry ?? NOW + 3600),
      maker: (over.maker ?? MAKER.address) as `0x${string}`,
    })
    const orderHash = hashTypedData({ domain: domainFor(), types: ORDER_TYPES, primaryType: 'Order', message: o })
    insertOrder(db, {
      orderHash,
      maker: o.maker.toLowerCase(),
      tokenIn: o.tokenIn.toLowerCase(),
      tokenOut: o.tokenOut.toLowerCase(),
      amountIn: o.amountIn.toString(),
      minAmountOut: o.minAmountOut.toString(),
      expiry: Number(o.expiry),
      nonce: o.nonce.toString(),
      receiver: o.receiver.toLowerCase(),
      fee: 3000,
      signature: '0x' + '11'.repeat(65),
      verifyingContract: LIMIT,
      chainId: CHAIN_ID,
      submittedAt: NOW,
    })
    return orderHash
  }

  it('lists stored orders with decoration, remaining fill and signature', async () => {
    const { app, db } = await harness()
    const openHash = store(db, { nonce: 31n })
    const partialHash = store(db, { nonce: 32n })
    insertEvents(db, [
      ev(
        'OrderFilled',
        {
          orderHash: partialHash,
          maker: MAKER.address,
          filler: OTHER.address,
          tokenIn: ADDR.dai,
          tokenOut: ADDR.weth,
          amountInFilled: 400n,
          amountOutPaid: 7n,
        },
        10
      ),
    ])

    const res = await app.inject({ method: 'GET', url: '/orders' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      orders: {
        orderHash: string
        nonce: string
        status: string
        fillable: boolean
        remaining: string
        filled: string
        signature: string
      }[]
      total: number
      limitOrders: string
    }
    expect(body.total).toBe(2)
    expect(body.limitOrders).toBe(LIMIT)
    expect(body.orders.length).toBe(2)

    const partial = body.orders.find((o) => o.orderHash === partialHash)!
    expect(partial.status).toBe('open') // partial fill still fillable
    expect(partial.fillable).toBe(true)
    expect(partial.filled).toBe('400')
    expect(partial.remaining).toBe('600')
    expect(partial.signature).toBe('0x' + '11'.repeat(65))

    const open = body.orders.find((o) => o.orderHash === openHash)!
    expect(open.status).toBe('open')
    expect(open.filled).toBe('0')
    expect(open.remaining).toBe('1000')
  })

  it('derives filled, cancelled and expired states from events and time', async () => {
    const { app, db } = await harness()
    const filled = store(db, { nonce: 33n, amountIn: 500n })
    insertEvents(db, [
      ev(
        'OrderFilled',
        {
          orderHash: filled,
          maker: MAKER.address,
          filler: OTHER.address,
          tokenIn: ADDR.dai,
          tokenOut: ADDR.weth,
          amountInFilled: 500n,
          amountOutPaid: 9n,
        },
        11
      ),
    ])
    const cancelled = store(db, { nonce: 34n })
    insertEvents(db, [ev('OrderCancelled', { maker: MAKER.address, nonce: 34n }, 12)])
    const expired = store(db, { nonce: 35n, expiry: NOW - 60 })

    const asList = async (status: string) => {
      const res = await app.inject({ method: 'GET', url: `/orders?status=${status}` })
      expect(res.statusCode).toBe(200)
      return (res.json() as { orders: { orderHash: string; status: string; fillable: boolean }[]; total: number })
    }

    const open = await asList('open')
    expect(open.total).toBe(0)
    const filledList = await asList('filled')
    expect(filledList.orders.map((o) => o.orderHash)).toEqual([filled])
    expect(filledList.orders[0]!.fillable).toBe(false)
    const cancelledList = await asList('cancelled')
    expect(cancelledList.orders.map((o) => o.orderHash)).toEqual([cancelled])
    const expiredList = await asList('expired')
    expect(expiredList.orders.map((o) => o.orderHash)).toEqual([expired])
    const all = await asList('all')
    expect(all.total).toBe(3)
  })

  it('reorg rollback makes a filled order open again (state lives in events, not rows)', async () => {
    const { app, db } = await harness()
    const hash = store(db, { nonce: 36n, amountIn: 1000n })
    insertEvents(db, [
      ev(
        'OrderFilled',
        {
          orderHash: hash,
          maker: MAKER.address,
          filler: OTHER.address,
          tokenIn: ADDR.dai,
          tokenOut: ADDR.weth,
          amountInFilled: 1000n,
          amountOutPaid: 3n,
        },
        20
      ),
    ])
    const filledRes = await app.inject({ method: 'GET', url: `/orders?status=filled` })
    expect((filledRes.json() as { total: number }).total).toBe(1)

    deleteEventsAfter(db, 19) // the fill lived in block 20
    const afterRes = await app.inject({ method: 'GET', url: `/orders?status=open` })
    const after = afterRes.json() as { orders: { orderHash: string; remaining: string }[]; total: number }
    expect(after.total).toBe(1)
    expect(after.orders[0]!.orderHash).toBe(hash)
    expect(after.orders[0]!.remaining).toBe('1000')
  })

  it('filters by maker and pages', async () => {
    const { app, db } = await harness()
    store(db, { nonce: 41n })
    store(db, { nonce: 42n })
    store(db, { nonce: 43n, maker: OTHER.address })

    const mine = await app.inject({ method: 'GET', url: `/orders?maker=${MAKER.address}` })
    const mineBody = mine.json() as { total: number; orders: { nonce: string }[] }
    expect(mineBody.total).toBe(2)
    expect(mineBody.orders.every((o) => Number(o.nonce) >= 41 && Number(o.nonce) <= 42)).toBe(true)

    const page = await app.inject({ method: 'GET', url: '/orders?limit=2&offset=2' })
    const pageBody = page.json() as { orders: unknown[]; total: number }
    expect(pageBody.total).toBe(3)
    expect(pageBody.orders.length).toBe(1)

    const upper = await app.inject({ method: 'GET', url: `/orders?maker=${OTHER.address}` })
    expect((upper.json() as { total: number }).total).toBe(1) // checksummed input still matches the stored lowercase row
  })

  it('returns an honest empty result when the chain has no limit-orders contract', async () => {
    const { limitOrders, ...rest } = MANIFEST
    const { app } = await harness({ manifest: rest })
    const res = await app.inject({ method: 'GET', url: '/orders' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { orders: unknown[]; total: number; limitOrders: string | null }
    expect(body.orders).toEqual([])
    expect(body.total).toBe(0)
    expect(body.limitOrders).toBeNull()
  })

  it('validates query parameters', async () => {
    const { app } = await harness()
    expect((await app.inject({ method: 'GET', url: '/orders?status=weird' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/orders?limit=0' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/orders?maker=nope' })).statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------- aggregation

describe('aggregate/orders', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
    seedPools(db)
  })

  it('decorateOrder precedence: fully filled > cancelled > expired > open', () => {
    const base = {
      orderHash: '0x' + '01'.repeat(32),
      maker: MAKER.address.toLowerCase(),
      tokenIn: ADDR.dai,
      tokenOut: ADDR.weth,
      amountIn: '1000',
      minAmountOut: '1',
      expiry: NOW + 3600,
      nonce: '50',
      receiver: MAKER.address.toLowerCase(),
      fee: 3000,
      signature: '0x' + '11'.repeat(65),
      verifyingContract: LIMIT,
      chainId: CHAIN_ID,
      submittedAt: NOW,
    }
    const fills = new Map([[base.orderHash, { filled: 1000n, out: 3n }]])
    const empty = new Map<string, { filled: bigint; out: bigint }>()
    const cancels = new Set([`${base.maker}:50`])

    expect(decorateOrder(base, fills, cancels, NOW).status).toBe('filled')
    expect(decorateOrder(base, empty, cancels, NOW).status).toBe('cancelled')
    expect(decorateOrder({ ...base, expiry: NOW - 1 }, empty, new Set(), NOW).status).toBe('expired')
    const open = decorateOrder(base, empty, new Set(), NOW)
    expect(open.status).toBe('open')
    expect(open.fillable).toBe(true)
    expect(open.remaining).toBe('1000')

    // cancelled + partially filled stays cancelled (not fillable)
    const partial = decorateOrder(base, new Map([[base.orderHash, { filled: 400n, out: 1n }]]), cancels, NOW)
    expect(partial.status).toBe('cancelled')
    expect(partial.fillable).toBe(false)
    expect(partial.remaining).toBe('600')
  })

  it('status filter pages correctly after filtering', () => {
    insertOrder(db, {
      orderHash: '0x' + '02'.repeat(32),
      maker: MAKER.address.toLowerCase(),
      tokenIn: ADDR.dai,
      tokenOut: ADDR.weth,
      amountIn: '1000',
      minAmountOut: '1',
      expiry: NOW - 1, // expired
      nonce: '60',
      receiver: MAKER.address.toLowerCase(),
      fee: 3000,
      signature: '0x',
      verifyingContract: LIMIT,
      chainId: CHAIN_ID,
      submittedAt: NOW,
    })
    insertOrder(db, {
      orderHash: '0x' + '03'.repeat(32),
      maker: MAKER.address.toLowerCase(),
      tokenIn: ADDR.dai,
      tokenOut: ADDR.weth,
      amountIn: '1000',
      minAmountOut: '1',
      expiry: NOW + 3600,
      nonce: '61',
      receiver: MAKER.address.toLowerCase(),
      fee: 3000,
      signature: '0x',
      verifyingContract: LIMIT,
      chainId: CHAIN_ID,
      submittedAt: NOW,
    })
    const expired = listOrders(db, LIMIT, { status: 'expired', limit: 1, offset: 0 }, NOW)
    expect(expired.total).toBe(1)
    expect(expired.orders[0]!.nonce).toBe('60')
    const open = listOrders(db, LIMIT, { status: 'open', limit: 1, offset: 0 }, NOW)
    expect(open.total).toBe(1)
    expect(open.orders[0]!.nonce).toBe('61')
  })
})

// ---------------------------------------------------------------- event decoding

describe('limit-order event fragments', () => {
  it('decodes OrderFilled and OrderCancelled exactly as the contract emits them', () => {
    const abi = parseAbi(LIMIT_ORDER_EVENTS)
    const orderHash = ('0x' + 'ab'.repeat(32)) as `0x${string}`
    const topics = encodeEventTopics({
      abi,
      eventName: 'OrderFilled',
      args: { orderHash, maker: MAKER.address, filler: OTHER.address },
    })
    const data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [ADDR.dai as `0x${string}`, ADDR.weth as `0x${string}`, 600n, 3n]
    )
    const [decoded] = decodeLogs([
      {
        address: LIMIT,
        topics,
        data,
        blockNumber: 5n,
        blockHash: '0x' + '11'.repeat(32),
        transactionHash: '0x' + '22'.repeat(32),
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
      } as never,
    ])
    expect(decoded!.event).toBe('OrderFilled')
    const args = JSON.parse(decoded!.args) as Record<string, string>
    expect(args.orderHash).toBe(orderHash)
    expect(args.amountInFilled).toBe('600')
    expect(args.amountOutPaid).toBe('3')

    const cancelTopics = encodeEventTopics({
      abi,
      eventName: 'OrderCancelled',
      args: { maker: MAKER.address }, // only indexed params go in topics; nonce is data
    })
    const [cancel] = decodeLogs([
      {
        address: LIMIT,
        topics: cancelTopics,
        data: encodeAbiParameters([{ type: 'uint256' }], [7n]),
        blockNumber: 6n,
        blockHash: '0x' + '11'.repeat(32),
        transactionHash: '0x' + '33'.repeat(32),
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
      } as never,
    ])
    expect(cancel!.event).toBe('OrderCancelled')
    const cancelArgs = JSON.parse(cancel!.args) as { maker: string; nonce: string }
    expect(cancelArgs.maker.toLowerCase()).toBe(MAKER.address.toLowerCase())
    expect(cancelArgs.nonce).toBe('7')
  })
})
