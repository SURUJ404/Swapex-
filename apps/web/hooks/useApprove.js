import { useCallback, useRef } from 'react'
import { Contract, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { useSigning } from '../context/SigningContext'
import useTransact from './useTransact'
import { useToast } from '../components/Toast'
import { parseError } from '../lib/errors'
import { REQUIRED_CHAIN_ID } from '../lib/config'
import {
  buildPermitTypedData,
  formatSigningSummary,
  signTypedDataWithGuard,
} from '../lib/typedData'
import {
  ERC20_ABI,
  ALLOWANCE_TRANSFER_ABI,
  ALLOWANCE_TRANSFER_ADDRESS,
} from '../constants'

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
// Grants are bounded by amount AND expire, so they are deliberately short-lived: the spend is
// submitted right after the grant, so an hour is generous while still capping exposure.
const GRANT_TTL_SECONDS = 60 * 60
// The permit nonce is an on-contract bitmap, not an account nonce: scan for the first unused
// slot. Testnet grant counts are tiny; if the bound is ever hit the grant fails closed.
const MAX_NONCE_SCAN = 1024

/**
 * Establishes the two grants a swap or liquidity add needs, each as its own tracked step:
 *   1. ERC-20 `approve(wallet -> AllowanceTransfer)` — a transaction; unlimited, normally set
 *      once per token, because the real bound (amount + expiry) lives in layer 2;
 *   2. a **signed EIP-712 grant** (crypto G.1): the wallet signs a PermitSingle — domain
 *      bound to the app's required chain, amount + expiry + nonce + signed deadline all inside
 *      the typed data — then the same wallet submits `permit(owner, message, sig)`. The app
 *      refuses to sign if the typed-data domain chain differs from the connected chain, shows
 *      a human-readable summary while the wallet prompt is open, and verifies the digest
 *      recovers to the expected signer before submitting.
 * Layer 1 is skipped when it already covers `amount`, so steady state is one approval tx plus
 * one signature + grant tx. `spender` is the Router; the token address is passed through.
 */
export default function useApprove() {
  const { library, chainId } = useWeb3()
  const { begin, end } = useSigning()
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

          // expiry from chain time so a skewed local clock cannot misstate the window
          const block = await library.getBlock('latest')
          const expiration = block.timestamp + GRANT_TTL_SECONDS

          // first permit slot this owner has not burned yet
          let nonce = 0
          while (nonce < MAX_NONCE_SCAN && (await at.isNonceUsed(owner, nonce))) nonce++
          if (nonce >= MAX_NONCE_SCAN) {
            throw new Error(`no free permit nonce under bound ${MAX_NONCE_SCAN}`)
          }

          // The domain uses the APP's required chain, not whatever the wallet reports:
          // signTypedDataWithGuard then refuses to sign if the connected chain differs,
          // so a wallet parked on another network can never collect a foreign-chain grant.
          const typedData = buildPermitTypedData({
            chainId: REQUIRED_CHAIN_ID,
            verifyingContract: ALLOWANCE_TRANSFER_ADDRESS,
            token: token.address,
            amount,
            expiration,
            nonce,
            spender,
            sigDeadline: expiration,
          })

          begin(formatSigningSummary(typedData, { tokenSymbol: token.symbol, tokenDecimals: token.decimals }))
          let sig
          try {
            sig = await signTypedDataWithGuard({
              signer,
              typedData,
              connectedChainId: chainId,
              expectedSigner: owner,
            })
          } finally {
            end()
          }

          return await run({
            label: `Grant Swapex a ${token.symbol} allowance`,
            successMessage: `${token.symbol} allowance granted`,
            onSuccess,
            send: async () => at.permit(owner, typedData.message, sig),
          })
        } catch (e) {
          // failures outside run() have no toast of their own
          addToast(parseError(e, `Approve ${token.symbol} failed`), 'error')
          return null
        } finally {
          inFlight.current = false
        }
      })(),
    [library, chainId, begin, end, run, addToast]
  )

  return { approve, approving: pending }
}
