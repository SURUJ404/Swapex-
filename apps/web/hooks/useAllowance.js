import { useState, useEffect, useCallback } from 'react'
import { BigNumber, Contract, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { ERC20_ABI } from '../constants'

/** ERC-20 allowance for `spender`. Native ETH never needs approval. */
export default function useAllowance(token, spender) {
  const { account, library, wrongNetwork } = useWeb3()
  const [allowance, setAllowance] = useState(null) // null = unknown yet
  const address = token?.address

  const refetch = useCallback(async () => {
    if (address === 'NATIVE') {
      setAllowance(constants.MaxUint256)
      return
    }
    if (!account || !library || !address || !spender || wrongNetwork) {
      setAllowance(null)
      return
    }
    try {
      const a = await new Contract(address, ERC20_ABI, library).allowance(account, spender)
      setAllowance(BigNumber.from(a))
    } catch {
      setAllowance(null)
    }
  }, [account, library, address, spender, wrongNetwork])

  useEffect(() => {
    setAllowance(null)
    refetch()
  }, [refetch])

  /** True only when we know the allowance and it is below `amount`. */
  const needsApproval = useCallback(
    (amount) => Boolean(amount) && address !== 'NATIVE' && allowance != null && allowance.lt(amount),
    [allowance, address]
  )

  return { allowance, needsApproval, refetch }
}
