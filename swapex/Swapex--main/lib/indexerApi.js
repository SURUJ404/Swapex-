// Typed client for the swapex indexer HTTP API (swapex-indexer/src/api).
//
// - Base URL comes from NEXT_PUBLIC_INDEXER_URL; unset -> null -> callers show
//   an honest "indexer not connected" state (never fake data).
// - Every response is validated with zod before it reaches the UI.
// - fetch is injectable for tests; each request has a timeout.
import { z } from 'zod'

export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || null

const DEFAULT_TIMEOUT_MS = 8000

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

const metaSchema = z.object({
  address: z.string().regex(ADDRESS_RE),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int().min(0).max(255),
})

const tokenSchema = metaSchema.extend({ usdPrice: z.number().nullable() })

const poolSchema = z.object({
  address: z.string().regex(ADDRESS_RE),
  fee: z.number(),
  token0: metaSchema,
  token1: metaSchema,
  price: z.number().nullable(),
  sqrtPriceX96: z.string().nullable(),
  liquidity: z.string().nullable(),
  tick: z.number().nullable(),
  volume24h: z.number(),
  fees24h: z.number(),
  txCount24h: z.number(),
  change24h: z.number().nullable(),
  reserves0: z.number(),
  reserves1: z.number(),
  tvlUsd: z.number().nullable(),
})

const candleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
})

const swapSchema = z.object({
  txHash: z.string(),
  timestamp: z.number(),
  amount0: z.number(),
  amount1: z.number(),
  sqrtPriceX96: z.string(),
  tick: z.number(),
})

const positionSchema = z.object({
  tokenId: z.string(),
  owner: z.string().nullable(),
  liquidityAdded: z.string(),
  liquidityRemoved: z.string(),
  feesCollected0Raw: z.string(),
  feesCollected1Raw: z.string(),
})

const healthSchema = z.object({ ok: z.boolean(), chainId: z.number(), cursor: z.number().nullable() })

/** A submitted order with its event-derived fill/cancel state (see swapex-indexer aggregate/orders). */
const orderSchema = z.object({
  orderHash: z.string(),
  maker: z.string().regex(ADDRESS_RE),
  tokenIn: z.string().regex(ADDRESS_RE),
  tokenOut: z.string().regex(ADDRESS_RE),
  amountIn: z.string(),
  minAmountOut: z.string(),
  expiry: z.number(),
  nonce: z.string(),
  receiver: z.string().regex(ADDRESS_RE),
  fee: z.number(),
  signature: z.string(),
  verifyingContract: z.string().regex(ADDRESS_RE),
  chainId: z.number(),
  submittedAt: z.number(),
  filled: z.string(),
  amountOutReceived: z.string(),
  remaining: z.string(),
  cancelled: z.boolean(),
  status: z.enum(['open', 'filled', 'cancelled', 'expired']),
  fillable: z.boolean(),
})

const ordersSchema = z.object({
  orders: z.array(orderSchema),
  total: z.number(),
  limitOrders: z.string().regex(ADDRESS_RE).nullable(),
  limit: z.number(),
  offset: z.number(),
})

/** Thrown for transport errors, non-2xx responses, and schema mismatches. */
export class IndexError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message)
    this.name = 'IndexerError'
    this.status = status ?? null
    if (cause) this.cause = cause
  }
}

export async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, init = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, headers: { accept: 'application/json', ...(init.headers || {}) } })
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(path, schema, { baseUrl = INDEXER_URL, timeoutMs, fetchImpl } = {}) {
  if (!baseUrl) return null
  let res
  try {
    res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}${path}`, { timeoutMs, fetchImpl })
  } catch (e) {
    throw new IndexError(`indexer request failed: ${e.name || e.message}`, { cause: e })
  }
  if (!res.ok) {
    throw new IndexError(`indexer responded ${res.status} for ${path}`, { status: res.status })
  }
  let body
  try {
    body = await res.json()
  } catch (e) {
    throw new IndexError(`indexer returned invalid JSON for ${path}`, { status: res.status, cause: e })
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new IndexError(`indexer response failed validation for ${path}: ${parsed.error.issues[0]?.message}`, {
      status: res.status,
    })
  }
  return parsed.data
}

/** True when an indexer base URL is configured in this build. */
export function indexerConfigured(baseUrl = INDEXER_URL) {
  return Boolean(baseUrl)
}

export function getHealth(opts) {
  return getJson('/health', healthSchema, opts)
}

export async function getTokens(opts) {
  const body = await getJson('/tokens', z.object({ tokens: z.array(tokenSchema) }), opts)
  return body && body.tokens
}

export function getToken(address, opts) {
  return getJson(`/tokens/${address}`, tokenSchema, opts)
}

export async function getPools({ limit, offset, ...opts } = {}) {
  const query = new URLSearchParams()
  if (limit != null) query.set('limit', String(limit))
  if (offset != null) query.set('offset', String(offset))
  const qs = query.toString()
  const body = await getJson(`/pools${qs ? `?${qs}` : ''}`, z.object({ pools: z.array(poolSchema), total: z.number() }), opts)
  return body && { pools: body.pools, total: body.total }
}

export function getPool(address, opts) {
  return getJson(`/pools/${address}`, poolSchema, opts)
}

export async function getPoolCandles(address, interval = '1H', opts) {
  const body = await getJson(
    `/pools/${address}/candles?interval=${encodeURIComponent(interval)}`,
    z.object({ interval: z.string(), candles: z.array(candleSchema) }),
    opts
  )
  return body && body.candles
}

export async function getPoolSwaps(address, { limit, offset, ...opts } = {}) {
  const query = new URLSearchParams()
  if (limit != null) query.set('limit', String(limit))
  if (offset != null) query.set('offset', String(offset))
  const qs = query.toString()
  const body = await getJson(
    `/pools/${address}/swaps${qs ? `?${qs}` : ''}`,
    z.object({ swaps: z.array(swapSchema) }),
    opts
  )
  return body && body.swaps
}

export async function getPositions(owner, opts) {
  const body = await getJson(`/positions?owner=${owner}`, z.object({ positions: z.array(positionSchema) }), opts)
  return body && body.positions
}

/**
 * Submitted limit orders with event-derived status. `maker` scopes to one wallet,
 * `status` to open/filled/cancelled/expired/all. Returns null when no indexer URL
 * is configured (callers show the honest "not connected" state).
 */
export async function getOrders({ maker, status, limit, offset, ...opts } = {}) {
  const query = new URLSearchParams()
  if (maker) query.set('maker', maker)
  if (status) query.set('status', status)
  if (limit != null) query.set('limit', String(limit))
  if (offset != null) query.set('offset', String(offset))
  const qs = query.toString()
  return getJson(`/orders${qs ? `?${qs}` : ''}`, ordersSchema, opts)
}

/** POST a signed order. Server-side rejection reasons (invalid signature, expired,
 *  no pool...) surface in the thrown IndexError's message — they are the UI copy. */
export async function postOrder(payload, opts) {
  const { baseUrl = INDEXER_URL, timeoutMs, fetchImpl } = opts || {}
  if (!baseUrl) return null
  const schema = z.object({
    orderHash: z.string(),
    status: z.enum(['accepted', 'duplicate']),
    checked: z.enum(['eoa', 'erc1271']),
  })
  const url = `${baseUrl.replace(/\/$/, '')}/orders`
  let res
  try {
    res = await fetchWithTimeout(url, {
      timeoutMs,
      fetchImpl,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    })
  } catch (e) {
    throw new IndexError(`indexer request failed: ${e.name || e.message}`, { cause: e })
  }
  let body = null
  try {
    body = await res.json()
  } catch (e) {
    throw new IndexError(`indexer returned invalid JSON for /orders`, { status: res.status, cause: e })
  }
  if (!res.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new IndexError(detail, { status: res.status })
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new IndexError(`indexer response failed validation for /orders: ${parsed.error.issues[0]?.message}`, {
      status: res.status,
    })
  }
  return parsed.data
}

/** True when the indexer answered 404 — the address simply is not indexed. */
export function isNotFound(error) {
  return Boolean(error) && error.status === 404
}

/**
 * Honest banner text for a failed indexer call: transport failures say the
 * indexer may be down, HTTP errors say which status came back. Callers map
 * 404 themselves (isNotFound) to an "unknown" state instead of an error.
 */
export function indexerErrorMessage(error) {
  const status = error && error.status
  if (!status) return 'Could not reach the indexer. Check that it is running, then reload.'
  if (status === 400) return 'The indexer rejected this request — check the address.'
  if (status === 404) return 'That address is not indexed.'
  if (status === 429) return 'Too many requests to the indexer. Wait a moment and reload.'
  return `The indexer returned an error (HTTP ${status}).`
}
