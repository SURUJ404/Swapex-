import { useState, useEffect, useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { ownerOf, position } from '../lib/contracts/positionManager'
import { getPool, slot0 } from '../lib/contracts/factory'
import { positionIdsTransferredTo, ownedTokenIds } from '../lib/contracts/events'
import { DEPLOYMENT } from '../lib/config'
import { getTokenMeta } from '../lib/tokenMeta'
import { sqrtPriceX96ToTick, isInRange } from '../lib/ticks'

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
 * The connected account's positions. The NFT contract has no enumeration, so this reads Transfer events
 * to the account and keeps the ids it still owns. An indexer will replace this later.
 */
export default function usePositions() {
  const { account, library, wrongNetwork } = useWeb3()
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refetch = useCallback(async () => {
    if (!DEPLOYMENT || !account || !library || wrongNetwork) {
      setPositions([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const ids = await positionIdsTransferredTo(library, account)
      const owned = await ownedTokenIds(library, account, ids)
      const loaded = await Promise.all(owned.map((id) => loadPosition(library, id)))
      loaded.sort((a, b) => Number(b.id) - Number(a.id))
      setPositions(loaded)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [account, library, wrongNetwork])

  useEffect(() => {
    Promise.resolve()
      .then(() => refetch())
      .catch(() => {})
  }, [refetch])

  return { positions, loading, error, refetch }
}
