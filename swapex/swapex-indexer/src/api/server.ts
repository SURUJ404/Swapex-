import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { getCursor, type Db } from '../db'
import type { Manifest } from '../deployment'
import { allPools, poolStats, listSwaps, positionsByOwner } from '../aggregate/pools'
import { buildCandles, CANDLE_INTERVALS, type CandleInterval } from '../aggregate/candles'
import { tokenUsdPrice, referenceStables, type TokenMetaProvider } from '../aggregate/prices'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

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

export interface ServerDeps {
  db: Db
  manifest: Manifest
  chainId: number
  corsOrigins: string[]
  meta: TokenMetaProvider
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

  return app
}
