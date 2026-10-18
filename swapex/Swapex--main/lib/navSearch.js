// Top-nav search: one input that routes to the right explore screen.
//
// Resolution order for a submitted query:
// 1. no indexer configured            -> /explore?q=… (that page shows the
//                                         honest not-connected state)
// 2. 0x…40 address                    -> token detail, else pool detail (direct
//                                         lookups, so lists with a limit cannot
//                                         hide the address), else /explore?q=…
// 3. exact token symbol               -> that token's detail page
// 4. "SYM0/SYM1" with exactly one pool -> that pool's detail page
// 5. anything else (including ambiguous
//    symbol/pair matches)             -> /explore?q=… where both tables filter
//
// Every decision is either a detail page we verified exists in the indexer or a
// list search the user can see the results of — never a dead link, never a guess
// presented as fact.
import { getTokens, getPools, getToken, getPool, indexerConfigured, isNotFound } from './indexerApi'

const POOL_LIMIT = 100

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function isAddressLike(query) {
  return ADDRESS_RE.test(String(query || '').trim())
}

/** `weth/tusdc`, `WETH - TUSDC` -> pool pair parts, else null. */
export function parsePairQuery(query) {
  const parts = String(query || '')
    .split(/\s*[/-]\s*/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return parts.length === 2 ? parts : null
}

/**
 * Pure routing for a non-address query against already-fetched indexer lists.
 * Ambiguous or unmatched input falls back to the filtered list page.
 */
export function decideTextRoute(query, { tokens = [], pools = [] } = {}) {
  const q = String(query || '').trim()
  const lower = q.toLowerCase()

  const symbolMatches = tokens.filter((t) => t && t.symbol && t.symbol.toLowerCase() === lower)
  if (symbolMatches.length === 1) return { pathname: `/explore/tokens/${symbolMatches[0].address}` }

  const pair = parsePairQuery(q)
  if (pair) {
    const [a, b] = pair
    const poolMatches = pools.filter((p) => {
      const s0 = p?.token0?.symbol?.toLowerCase()
      const s1 = p?.token1?.symbol?.toLowerCase()
      return (s0 === a && s1 === b) || (s0 === b && s1 === a)
    })
    if (poolMatches.length === 1) return { pathname: `/explore/pools/${poolMatches[0].address}` }
  }

  return { pathname: '/explore', query: { q } }
}

/**
 * Full resolution for one submitted query. Resolves to a next/router push
 * target, or null for an empty query. Transport/HTTP errors are rethrown —
 * callers show their own honest error path instead of a silent wrong route.
 *
 * `opts` is passed through to the indexer client (fetchImpl/baseUrl for tests).
 */
export async function resolveRoute(rawQuery, opts = {}) {
  const query = String(rawQuery || '').trim()
  if (!query) return null
  if (!indexerConfigured(opts.baseUrl)) return { pathname: '/explore', query: { q: query } }

  if (isAddressLike(query)) {
    try {
      await getToken(query, opts)
      return { pathname: `/explore/tokens/${query}` }
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
    try {
      await getPool(query, opts)
      return { pathname: `/explore/pools/${query}` }
    } catch (e) {
      if (!isNotFound(e)) throw e
      return { pathname: '/explore', query: { q: query } }
    }
  }

  const [tokens, pools] = await Promise.all([getTokens(opts), getPools({ limit: POOL_LIMIT, ...opts })])
  return decideTextRoute(query, { tokens: tokens || [], pools: (pools && pools.pools) || [] })
}
