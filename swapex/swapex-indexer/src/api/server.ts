import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { hashTypedData, verifyTypedData, type PublicClient } from 'viem'
import { getCursor, insertOrder, type Db } from '../db'
import type { Manifest } from '../deployment'
import { allPools, poolStats, listSwaps, positionsByOwner } from '../aggregate/pools'
import { buildCandles, CANDLE_INTERVALS, type CandleInterval } from '../aggregate/candles'
import { tokenUsdPrice, referenceStables, type TokenMetaProvider } from '../aggregate/prices'
import { listOrders, type OrderStatus } from '../aggregate/orders'
import { ERC1271_ABI, ERC1271_MAGIC, ORDER_TYPES, orderDomain, type OrderMessage } from '../eip712'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UINT = /^\d+$/
const SIGNATURE_65 = /^0x[0-9a-fA-F]{130}$/ // r (32) || s (32) || v (1)

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})

const candleQuerySchema = z.object({
  interval: z.enum(CANDLE_INTERVALS as unknown as [CandleInterval, ...CandleInterval[]]).default('1H'),
})

const ownerSchema = z.object({
  owner: z.string().regex(ADDRESS, 'owner must be a 0x address'),
})

const addressParamSchema = z.object({
  address: z.string().regex(ADDRESS, 'address must be a 0x address'),
})

const orderBodySchema = z.object({
  order: z.object({
    maker: z.string().regex(ADDRESS, 'maker must be a 0x address'),
    tokenIn: z.string().regex(ADDRESS, 'tokenIn must be a 0x address'),
    tokenOut: z.string().regex(ADDRESS, 'tokenOut must be a 0x address'),
    amountIn: z.string().regex(UINT, 'amountIn must be a decimal integer string'),
    minAmountOut: z.string().regex(UINT, 'minAmountOut must be a decimal integer string'),
    expiry: z.string().regex(UINT, 'expiry must be a decimal integer string'),
    nonce: z.string().regex(UINT, 'nonce must be a decimal integer string'),
    receiver: z.string().regex(ADDRESS, 'receiver must be a 0x address'),
  }),
  signature: z.string().regex(SIGNATURE_65, 'signature must be a 65-byte hex string (r || s || v)'),
  fee: z.number().int().min(1).max(1_000_000, 'fee must be a pool fee tier in hundredths of a bip'),
})

const ordersQuerySchema = pageSchema.extend({
  maker: z.string().regex(ADDRESS, 'maker must be a 0x address').optional(),
  status: z.enum(['open', 'filled', 'cancelled', 'expired', 'all']).default('all'),
})

/** views needed to reject orders the chain already knows are dead */
const LIMIT_VIEWS = [
  {
    type: 'function',
    name: 'orders',
    stateMutability: 'view',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [
      { name: 'filled', type: 'uint256' },
      { name: 'amountOutReceived', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'cancelled',
    stateMutability: 'view',
    inputs: [
      { name: 'maker', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const ZERO = '0x0000000000000000000000000000000000000000'

export interface ServerDeps {
  db: Db
  manifest: Manifest
  chainId: number
  corsOrigins: string[]
  meta: TokenMetaProvider
  /** live RPC client; when present, POST /orders also checks ERC-1271 wallets and on-chain order state */
  client?: PublicClient
}

/** Fastify app for the indexer API. Stateless: all data comes from the db. */
export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: false })

  await app.register(cors, { origin: deps.corsOrigins })
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500
    reply.status(status).send({ error: err.message })
  })

  app.get('/health', async () => ({
    ok: true,
    chainId: deps.chainId,
    cursor: getCursor(deps.db),
  }))

  app.get('/tokens', async () => {
    const rows = allPools(deps.db)
    const addresses = new Set<string>()
    for (const r of rows) {
      addresses.add(r.token0)
      addresses.add(r.token1)
    }
    for (const s of referenceStables(deps.manifest)) addresses.add(s.address)
    const out = []
    for (const address of addresses) {
      const meta = await deps.meta(address)
      out.push({ ...meta, usdPrice: await tokenUsdPrice(deps.db, deps.manifest, address, deps.meta) })
    }
    return { tokens: out }
  })

  app.get('/tokens/:address', async (req, reply) => {
    const parsed = addressParamSchema.safeParse(req.params)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message })
    const address = parsed.data.address.toLowerCase()
    const inPools = allPools(deps.db).some((p) => p.token0 === address || p.token1 === address)
    const inManifest = deps.manifest.tokens.some((t) => t.address.toLowerCase() === address)
    if (!inPools && !inManifest) return reply.status(404).send({ error: 'unknown token' })
    const meta = await deps.meta(address)
    return { ...meta, usdPrice: await tokenUsdPrice(deps.db, deps.manifest, address, deps.meta) }
  })

  app.get('/pools', async (req, reply) => {
    const parsed = pageSchema.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message })
    const pools = allPools(deps.db).slice(parsed.data.offset, parsed.data.offset + parsed.data.limit)
    const out = []
    for (const p of pools) {
      out.push(await poolStats(deps.db, deps.manifest, p.address, deps.meta))
    }
    return { pools: out, total: allPools(deps.db).length }
  })

  app.get('/pools/:address', async (req, reply) => {
    const parsed = addressParamSchema.safeParse(req.params)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message })
    const stats = await poolStats(deps.db, deps.manifest, parsed.data.address, deps.meta)
    if (!stats) return reply.status(404).send({ error: 'unknown pool' })
    return stats
  })

  app.get('/pools/:address/candles', async (req, reply) => {
    const params = addressParamSchema.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: params.error.message })
    const query = candleQuerySchema.safeParse(req.query)
    if (!query.success) return reply.status(400).send({ error: query.error.message })
    const stats = await poolStats(deps.db, deps.manifest, params.data.address, deps.meta)
    if (!stats) return reply.status(404).send({ error: 'unknown pool' })

    const rows = deps.db
      .prepare(
        `SELECT e.args, b.timestamp FROM events e
         JOIN blocks b ON b.number = e.block_number
         WHERE e.address = ? AND e.event = 'Swap'
         ORDER BY e.block_number, e.log_index`
      )
      .all(params.data.address.toLowerCase()) as { args: string; timestamp: number }[]
    const swaps = rows.map((r) => {
      const a = JSON.parse(r.args) as { sqrtPriceX96: string; amount0: string }
      return {
        timestamp: r.timestamp,
        sqrtPriceX96: BigInt(a.sqrtPriceX96),
        amount0: BigInt(a.amount0) < 0n ? -BigInt(a.amount0) : BigInt(a.amount0),
      }
    })
    const candles = buildCandles(swaps, query.data.interval, stats.token0.decimals, stats.token1.decimals)
    return { interval: query.data.interval, candles }
  })

  app.get('/pools/:address/swaps', async (req, reply) => {
    const params = addressParamSchema.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ error: params.error.message })
    const query = pageSchema.safeParse(req.query)
    if (!query.success) return reply.status(400).send({ error: query.error.message })
    const stats = await poolStats(deps.db, deps.manifest, params.data.address, deps.meta)
    if (!stats) return reply.status(404).send({ error: 'unknown pool' })
    const swaps = listSwaps(deps.db, params.data.address, stats.token0, stats.token1, query.data)
    return { swaps, ...query.data }
  })

  app.get('/positions', async (req, reply) => {
    const parsed = ownerSchema.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message })
    const positions = positionsByOwner(deps.db, parsed.data.owner, deps.manifest.positionManager)
    return { positions }
  })

  /** Pool for the pair at that fee tier? (no pool -> the keeper could never fill) */
  const poolExists = (tokenIn: string, tokenOut: string, fee: number): boolean => {
    const a = tokenIn.toLowerCase()
    const b = tokenOut.toLowerCase()
    return allPools(deps.db).some(
      (p) => p.fee === fee && ((p.token0 === a && p.token1 === b) || (p.token0 === b && p.token1 === a))
    )
  }

  // ---------------------------------------------------------------- limit orders
  /**
   * Submit a signed limit order. Everything the contract would check is checked here
   * against *this* chain's domain: payload shape, the contract's own field validation,
   * the maker's EIP-712 signature (EOA, then ERC-1271 when a client is wired), pool
   * existence, and - with a live client - that the order is not already filled or
   * cancelled on chain. The signature is re-verified on submit: what is stored is only
   * what the maker actually signed (plus the fee tier, which is not signed).
   */
  app.post('/orders', async (req, reply) => {
    const parsed = orderBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message })
    const { order: o, signature, fee } = parsed.data

    const limitOrders = deps.manifest.limitOrders
    if (!limitOrders) {
      return reply.status(503).send({ error: 'limit orders contract is not deployed on this chain' })
    }

    // field validation, mirroring SwapexLimitOrders.fill's checks and their order
    if (BigInt(o.amountIn) === 0n || BigInt(o.minAmountOut) === 0n) {
      return reply.status(400).send({ error: 'amountIn and minAmountOut must be greater than zero' })
    }
    if (o.tokenIn.toLowerCase() === o.tokenOut.toLowerCase()) {
      return reply.status(400).send({ error: 'tokenIn and tokenOut must differ' })
    }
    if (o.maker.toLowerCase() === ZERO) return reply.status(400).send({ error: 'maker must not be the zero address' })
    if (o.receiver.toLowerCase() === ZERO) return reply.status(400).send({ error: 'receiver must not be the zero address' })
    const expiry = Number(o.expiry)
    if (!Number.isSafeInteger(expiry) || expiry <= 0) return reply.status(400).send({ error: 'expiry out of range' })
    const now = Math.floor(Date.now() / 1000)
    if (now > expiry) return reply.status(400).send({ error: 'order expired' })
    if (!poolExists(o.tokenIn, o.tokenOut, fee)) {
      return reply.status(400).send({ error: 'no pool for this pair at that fee tier' })
    }

    const message: OrderMessage = {
      maker: o.maker as `0x${string}`,
      tokenIn: o.tokenIn as `0x${string}`,
      tokenOut: o.tokenOut as `0x${string}`,
      amountIn: BigInt(o.amountIn),
      minAmountOut: BigInt(o.minAmountOut),
      expiry: BigInt(o.expiry),
      nonce: BigInt(o.nonce),
      receiver: o.receiver as `0x${string}`,
    }
    const domain = orderDomain(deps.chainId, limitOrders as `0x${string}`)
    const orderHash = hashTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message })

    // EOA first (what OZ SignatureChecker tries), then ERC-1271 for contract makers
    let valid = false
    let checked: 'eoa' | 'erc1271' = 'eoa'
    try {
      valid = await verifyTypedData({
        address: message.maker,
        domain,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message,
        signature: signature as `0x${string}`,
      })
    } catch {
      valid = false // malformed for viem -> not a valid signature either
    }
    if (!valid && deps.client) {
      try {
        const code = await deps.client.getBytecode({ address: message.maker })
        if (code && code !== '0x') {
          const magic = await deps.client.readContract({
            address: message.maker,
            abi: ERC1271_ABI,
            functionName: 'isValidSignature',
            args: [orderHash as `0x${string}`, signature as `0x${string}`],
          })
          if (String(magic).toLowerCase() === ERC1271_MAGIC) {
            valid = true
            checked = 'erc1271'
          }
        }
      } catch {
        valid = false // wallet has no working ERC-1271: stays invalid
      }
    }
    if (!valid) {
      return reply
        .status(400)
        .send({ error: 'invalid signature', detail: 'does not verify as the maker EOA or through ERC-1271' })
    }

    // on-chain dead-order checks (only possible against a live client)
    if (deps.client) {
      try {
        const state = await deps.client.readContract({
          address: limitOrders as `0x${string}`,
          abi: LIMIT_VIEWS,
          functionName: 'orders',
          args: [orderHash as `0x${string}`],
        })
        if (state[0] >= BigInt(o.amountIn)) return reply.status(409).send({ error: 'order is already filled' })
        const isCancelled = await deps.client.readContract({
          address: limitOrders as `0x${string}`,
          abi: LIMIT_VIEWS,
          functionName: 'cancelled',
          args: [message.maker, message.nonce],
        })
        if (isCancelled) return reply.status(409).send({ error: 'order nonce is cancelled' })
      } catch {
        return reply.status(502).send({ error: 'could not read order state from the chain' })
      }
    }

    const result = insertOrder(deps.db, {
      orderHash,
      maker: message.maker.toLowerCase(),
      tokenIn: message.tokenIn.toLowerCase(),
      tokenOut: message.tokenOut.toLowerCase(),
      amountIn: o.amountIn,
      minAmountOut: o.minAmountOut,
      expiry,
      nonce: o.nonce,
      receiver: message.receiver.toLowerCase(),
      fee,
      signature,
      verifyingContract: limitOrders.toLowerCase(),
      chainId: deps.chainId,
      submittedAt: now,
    })
    if (result === 'fee-conflict') {
      return reply.status(409).send({ error: 'order already stored with a different fee tier' })
    }
    return reply.status(result === 'inserted' ? 201 : 200).send({ orderHash, status: result === 'inserted' ? 'accepted' : 'duplicate', checked })
  })

  /** Submitted orders with event-derived fill/cancel state. `status=open` is the keeper's list. */
  app.get('/orders', async (req, reply) => {
    const parsed = ordersQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message })
    const { maker, status, limit, offset } = parsed.data
    const limitOrders = deps.manifest.limitOrders
    if (!limitOrders) return { orders: [], total: 0, limitOrders: null, limit, offset }
    const { orders, total } = listOrders(
      deps.db,
      limitOrders,
      { maker: maker?.toLowerCase(), status: status as OrderStatus | 'all', limit, offset },
      Math.floor(Date.now() / 1000)
    )
    return { orders, total, limitOrders, limit, offset }
  })

  return app
}
