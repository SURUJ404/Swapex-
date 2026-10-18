import { useState, useEffect, useCallback } from 'react'
import { BigNumber } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { balanceOf } from '../lib/contracts/erc20'

/** Balance of a token entry ({address, decimals}) as base units. Refreshes on each new block. */
export default function useTokenBalance(token) {
  const { account, library, wrongNetwork } = useWeb3()
  const [balance, setBalance] = useState(BigNumber.from(0))
  const [loading, setLoading] = useState(false)
  const address = token?.address

  const refetch = useCallback(async () => {
    if (!account || !library || !address || wrongNetwork) {
      setBalance(BigNumber.from(0))
      return
    }
    try {
      const bal =
        address === 'NATIVE'
          ? await library.getBalance(account)
          : await balanceOf(library, address, account)
      setBalance(bal)
    } catch (e) {
      console.error('useTokenBalance error:', e)
    }
  }, [account, library, address, wrongNetwork])

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
    if (!library) return () => { cancelled = true }
    const onBlock = () => refetch()
    library.on('block', onBlock)
    return () => {
      cancelled = true
      library.removeListener('block', onBlock)
    }
  }, [refetch, library])

  return { balance, loading, refetch }
}
