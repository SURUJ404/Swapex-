import { useCallback, useRef } from 'react'
import { Contract, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import useTransact from './useTransact'
import { useToast } from '../components/Toast'
import { parseError } from '../lib/errors'
import {
  ERC20_ABI,
  ALLOWANCE_TRANSFER_ABI,
  ALLOWANCE_TRANSFER_ADDRESS,
} from '../constants'

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
// Grants are bounded by amount AND expire, so they are deliberately short-lived: the spend is
// submitted right after the grant, so an hour is generous while still capping exposure.
const GRANT_TTL_SECONDS = 60 * 60

/**
 * Establishes the two grants a swap or liquidity add needs, each as its own tracked tx:
 *   1. ERC-20 `approve(wallet -> AllowanceTransfer)` — unlimited, normally set once per token,
 *      because the real bound (amount + expiry) lives in layer 2;
 *   2. `setAllowance(AllowanceTransfer -> spender)` for exactly `amount`, expiring in an hour.
 * Layer 1 is skipped when it already covers `amount`, so steady state is a single transaction.
 * `spender` is the Router address; the token address is passed through unchanged.
 */
export default function useApprove() {
  const { library } = useWeb3()
  const { run, pending } = useTransact()
  const { addToast } = useToast()
  const inFlight = useRef(false)

  const approve = useCallback(
    (token, spender, amount, currentAllowance, onSuccess) =>
      (async () => {
        if (inFlight.current) return null
        inFlight.current = true
        try {
          const signer = library.getSigner()
          const owner = await signer.getAddress()
          const erc20 = new Contract(token.address, ERC20_ABI, signer)
          const at = new Contract(ALLOWANCE_TRANSFER_ADDRESS, ALLOWANCE_TRANSFER_ABI, signer)

          const outer = await erc20.allowance(owner, ALLOWANCE_TRANSFER_ADDRESS)
          if (outer.lt(amount)) {
            // USDT reverts when changing a non-zero allowance, so it is reset to 0 first.
            if (token.address.toLowerCase() === USDT && !outer.isZero()) {
              const reset = await run({
                label: `Reset ${token.symbol} approval`,
                send: async () => erc20.approve(ALLOWANCE_TRANSFER_ADDRESS, constants.Zero),
              })
              if (!reset) return null
            }
            const first = await run({
              label: `Approve ${token.symbol} for Swapex`,
              successMessage: `${token.symbol} approved`,
              send: async () => erc20.approve(ALLOWANCE_TRANSFER_ADDRESS, constants.MaxUint256),
            })
            // never attempt the grant on top of a rejected or failed outer approval
            if (!first) return null
          }

          return await run({
            label: `Grant Swapex a ${token.symbol} allowance`,
            successMessage: `${token.symbol} allowance granted`,
            onSuccess,
            send: async () => {
              // expiry from chain time so a skewed local clock cannot misstate the window
              const block = await library.getBlock('latest')
              return at.setAllowance(
                token.address,
                spender,
                amount,
                block.timestamp + GRANT_TTL_SECONDS
              )
            },
          })
        } catch (e) {
          // failures outside run() have no toast of their own
          addToast(parseError(e, `Approve ${token.symbol} failed`), 'error')
          return null
        } finally {
          inFlight.current = false
        }
      })(),
    [library, run, addToast]
  )

  return { approve, approving: pending }
}
