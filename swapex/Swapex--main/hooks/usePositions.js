import { useState, useEffect, useCallback } from 'react'
import { Contract } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import positionManagerAbi from '../lib/abi/SwapexPositionManager.json'
import factoryAbi from '../lib/abi/SwapexFactory.json'
import poolAbi from '../lib/abi/SwapexPool.json'
import { DEPLOYMENT } from '../lib/config'
import { getTokenMeta } from '../lib/tokenMeta'
import { sqrtPriceX96ToTick, isInRange } from '../lib/ticks'

/** Everything the UI needs about one position NFT, in one place. */
export async function loadPosition(library, tokenId) {
  const pm = new Contract(DEPLOYMENT.positionManager, positionManagerAbi, library)
  const factory = new Contract(DEPLOYMENT.factory, factoryAbi, library)
  const [owner, p] = await Promise.all([pm.ownerOf(tokenId), pm.positions(tokenId)])
  const [token0, token1, poolAddress] = await Promise.all([
    getTokenMeta(library, p.token0),
    getTokenMeta(library, p.token1),
    factory.getPool(p.token0, p.token1, p.fee),
  ])
  const slot0 = await new Contract(poolAddress, poolAbi, library).slot0()
  const sqrtPriceX96 = slot0.sqrtPriceX96.toString()
  const currentTick = Number(slot0.tick)
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
      const pm = new Contract(DEPLOYMENT.positionManager, positionManagerAbi, library)
      const from = DEPLOYMENT.blockNumber || 0
      const logs = await pm.queryFilter(pm.filters.Transfer(null, account), from)
      const ids = [...new Set(logs.map((l) => l.args.tokenId.toString()))]
      const owned = []
      for (const id of ids) {
        try {
          if ((await pm.ownerOf(id)).toLowerCase() === account.toLowerCase()) owned.push(id)
        } catch {
          // burned
        }
      }
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
    refetch()
  }, [refetch])

  return { positions, loading, error, refetch }
}
