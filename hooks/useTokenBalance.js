import { useState, useEffect, useCallback } from 'react'
import { BigNumber, Contract } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { ERC20_ABI } from '../constants'

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
          : await new Contract(address, ERC20_ABI, library).balanceOf(account)
      setBalance(bal)
    } catch (e) {
      console.error('useTokenBalance error:', e)
    }
  }, [account, library, address, wrongNetwork])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    refetch().finally(() => !cancelled && setLoading(false))
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
