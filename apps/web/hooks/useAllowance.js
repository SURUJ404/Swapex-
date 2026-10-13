import { useState, useEffect, useCallback } from 'react'
import { BigNumber, Contract, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import {
  ERC20_ABI,
  ALLOWANCE_TRANSFER_ABI,
  ALLOWANCE_TRANSFER_ADDRESS,
} from '../constants'

/**
 * Spendable allowance for `spender` (the Router) over `token`.
 *
 * Spending requires two grants to hold at once:
 *   1. the ERC-20 allowance from the wallet to the AllowanceTransfer (outer layer, normally
 *      unlimited and set once per token), and
 *   2. the bounded, expiring grant from the AllowanceTransfer to `spender`.
 * The effective allowance is the smaller of the two, and an expired grant counts as zero —
 * which is exactly what the contracts enforce at spend time, so `needsApproval` stays honest.
 * Native ETH never needs approval.
 */
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
      const erc20 = new Contract(address, ERC20_ABI, library)
      const at = new Contract(ALLOWANCE_TRANSFER_ADDRESS, ALLOWANCE_TRANSFER_ABI, library)
      // expiry is compared against chain time, not the local clock, so a skewed client clock
      // cannot claim an expired grant is still spendable
      const [outer, grant, block] = await Promise.all([
        erc20.allowance(account, ALLOWANCE_TRANSFER_ADDRESS),
        at.allowanceOf(account, address, spender),
        library.getBlock('latest'),
      ])
      const outerBn = BigNumber.from(outer)
      const expired = BigNumber.from(grant.expiration).lte(block.timestamp)
      const grantBn = expired ? constants.Zero : BigNumber.from(grant.amount)
      setAllowance(outerBn.lt(grantBn) ? outerBn : grantBn)
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
