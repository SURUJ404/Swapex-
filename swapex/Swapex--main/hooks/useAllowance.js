import { useState, useEffect, useCallback } from 'react'
import { BigNumber, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { allowance as readAllowance } from '../lib/contracts/erc20'

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
      const a = await readAllowance(library, address, account, spender)
      setAllowance(BigNumber.from(a))
    } catch {
      setAllowance(null)
    }
  }, [account, library, address, spender, wrongNetwork])

  useEffect(() => {
    // deferred so the reset and the fetch state updates land in the async continuation
    Promise.resolve()
      .then(() => {
        setAllowance(null)
        return refetch()
      })
      .catch(() => {})
  }, [refetch])

  /** True only when we know the allowance and it is below `amount`. */
  const needsApproval = useCallback(
    (amount) => Boolean(amount) && address !== 'NATIVE' && allowance != null && allowance.lt(amount),
    [allowance, address]
  )

  return { allowance, needsApproval, refetch }
}
