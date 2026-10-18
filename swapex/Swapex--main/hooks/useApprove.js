import { useCallback } from 'react'
import { Contract } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import useTransact from './useTransact'
import { ERC20_ABI } from '../constants'

/** Approve exactly `amount` (not unlimited) for `spender`. */
export default function useApprove() {
  const { library } = useWeb3()
  const { run, pending } = useTransact()

  const approve = useCallback(
    (token, spender, amount, currentAllowance, onSuccess) =>
      run({
        label: `Approve ${token.symbol}`,
        successMessage: `${token.symbol} approved`,
        onSuccess,
        send: async () => {
          const c = new Contract(token.address, ERC20_ABI, library.getSigner())
          return c.approve(spender, amount)
        },
      }),
    [library, run]
  )

  return { approve, approving: pending }
}
