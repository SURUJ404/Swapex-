import { useState, useEffect, useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { balanceOf } from '../lib/contracts/erc20'

/** Balance of a token entry ({address, decimals}) as base units. Refreshes on each new block. */
export default function useTokenBalance(token) {
  const { account, clients, wrongNetwork } = useWeb3()
  const publicClient = clients.public
  const [balance, setBalance] = useState(0n)
  const [loading, setLoading] = useState(false)
  const address = token?.address

  const refetch = useCallback(async () => {
    if (!account || !publicClient || !address || wrongNetwork) {
      setBalance(0n)
      return
    }
    try {
      const bal =
        address === 'NATIVE'
          ? await publicClient.getBalance({ address: account })
          : await balanceOf(publicClient, address, account)
      setBalance(bal)
    } catch (e) {
      console.error('useTokenBalance error:', e)
    }
  }, [account, publicClient, address, wrongNetwork])

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined
        setLoading(true)
        return refetch()
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    if (!publicClient) return () => { cancelled = true }
    const unwatch = publicClient.watchBlockNumber({ onBlockNumber: () => refetch() })
    return () => {
      cancelled = true
      unwatch()
    }
  }, [refetch, publicClient])

  return { balance, loading, refetch }
}
