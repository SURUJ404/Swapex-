import { useState, useEffect, useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { ownerOf, position } from '../lib/contracts/positionManager'
import { getPool, slot0 } from '../lib/contracts/factory'
import { positionIdsTransferredTo, ownedTokenIds } from '../lib/contracts/events'
import { DEPLOYMENT } from '../lib/config'
import { getTokenMeta } from '../lib/tokenMeta'
import { sqrtPriceX96ToTick, isInRange } from '../lib/ticks'
import { getHealth, getPositions, indexerConfigured } from '../lib/indexerApi'
import { discoverPositionIds, positionIdsFromRows } from '../lib/positionSource'

/** Everything the UI needs about one position NFT, in one place. */
export async function loadPosition(library, tokenId) {
  const [owner, p] = await Promise.all([ownerOf(library, tokenId), position(library, tokenId)])
  const [token0, token1, poolAddress] = await Promise.all([
    getTokenMeta(library, p.token0),
    getTokenMeta(library, p.token1),
    getPool(library, p.token0, p.token1, p.fee),
  ])
  const s0 = await slot0(library, poolAddress)
  const sqrtPriceX96 = s0.sqrtPriceX96.toString()
  const currentTick = Number(s0.tick)
  return {
    id: tokenId.toString(),
    owner,
    token0,
    token1,
    fee: Number(p.fee),
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: p.liquidity,
    tokensOwed0: p.tokensOwed0,
    tokensOwed1: p.tokensOwed1,
    poolAddress,
    sqrtPriceX96,
    currentTick: Number.isFinite(currentTick) ? currentTick : sqrtPriceX96ToTick(sqrtPriceX96),
    inRange: isInRange(currentTick, Number(p.tickLower), Number(p.tickUpper)),
  }
}

/**
 * The connected account's positions.
 *
 * Id discovery: the indexer's /positions?owner= when one is configured — its
 * rows cover everything up to the cursor, and a small Transfer-log scan from
 * the cursor to the chain head covers events it has not ingested yet (the union
 * is therefore complete). On any indexer problem (not configured, wrong chain,
 * request failed, no rows) it falls back to the full Transfer-event scan from
 * the deployment block — the pre-indexer behaviour. Either way every id is
 * verified with ownerOf and hydrated on-chain, so a stale indexer response can
 * never surface a position the account does not own.
 */
export default function usePositions() {
  const { account, library, wrongNetwork } = useWeb3()
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Indexer branch: null when not configured, not yet synced (no cursor -> the
  // gap scan has no start point), or the health check disagrees with this app's
  // chain (a cross-chain indexer must never feed position ids).
  const fromIndexer = useCallback(async (owner) => {
    if (!indexerConfigured()) return null
    const health = await getHealth()
    if (!health || health.chainId !== DEPLOYMENT?.chainId || health.cursor == null) return null
    const rows = await getPositions(owner)
    // gapFrom = last indexed block (inclusive overlap is deduped by the id Set)
    return { ids: positionIdsFromRows(rows), gapFrom: health.cursor }
  }, [])

  const fromEvents = useCallback((owner, fromBlock) => positionIdsTransferredTo(library, owner, fromBlock), [library])

  const refetch = useCallback(async () => {
    if (!DEPLOYMENT || !account || !library || wrongNetwork) {
      setPositions([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { ids } = await discoverPositionIds(account, { fromIndexer, fromEvents })
      const owned = await ownedTokenIds(library, account, ids)
      const loaded = await Promise.all(owned.map((id) => loadPosition(library, id)))
      loaded.sort((a, b) => Number(b.id) - Number(a.id))
      setPositions(loaded)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [account, library, wrongNetwork, fromIndexer, fromEvents])

  useEffect(() => {
    Promise.resolve()
      .then(() => refetch())
      .catch(() => {})
  }, [refetch])

  return { positions, loading, error, refetch }
}
