import { useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import useTransact from './useTransact'
import { approve as approveToken } from '../lib/contracts/erc20'

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
        send: () => approveToken(library.getSigner(), token.address, spender, amount),
      }),
    [library, run]
  )

  return { approve, approving: pending }
}
