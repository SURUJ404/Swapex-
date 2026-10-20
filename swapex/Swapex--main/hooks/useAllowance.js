import { useState, useEffect, useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { allowance as readAllowance } from '../lib/contracts/erc20'

const MAX_UINT256 = (1n << 256n) - 1n

/** ERC-20 allowance for `spender`. Native ETH never needs approval. */
export default function useAllowance(token, spender) {
  const { account, clients, wrongNetwork } = useWeb3()
  const [allowance, setAllowance] = useState(null) // null = unknown yet
  const address = token?.address
  const publicClient = clients.public

  const refetch = useCallback(async () => {
    if (address === 'NATIVE') {
      setAllowance(MAX_UINT256)
      return
    }
    if (!account || !publicClient || !address || !spender || wrongNetwork) {
      setAllowance(null)
      return
    }
    try {
      setAllowance(await readAllowance(publicClient, address, account, spender))
    } catch {
      setAllowance(null)
    }
  }, [account, publicClient, address, spender, wrongNetwork])

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
    (amount) => Boolean(amount) && address !== 'NATIVE' && allowance != null && allowance < amount,
    [allowance, address]
  )

  return { allowance, needsApproval, refetch }
}
