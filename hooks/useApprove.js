import { useCallback } from 'react'
import { Contract, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import useTransact from './useTransact'
import { ERC20_ABI } from '../constants'

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'

/**
 * Approve exactly `amount` (not unlimited) for `spender`.
 * USDT reverts when changing a non-zero allowance, so it is reset to 0 first.
 */
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
          if (token.address.toLowerCase() === USDT && currentAllowance && currentAllowance.gt(constants.Zero)) {
            const reset = await c.approve(spender, 0)
            await reset.wait()
          }
          return c.approve(spender, amount)
        },
      }),
    [library, run]
  )

  return { approve, approving: pending }
}
