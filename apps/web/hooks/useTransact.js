import { useState, useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { useToast } from '../components/Toast'
import { parseError } from '../lib/errors'
import { addTransaction, setTransactionStatus } from '../lib/txHistory'

/**
 * Runs a transaction-sending function with consistent behavior:
 * pending entry in history, wait for receipt, status update, friendly errors.
 * `send` must return the ethers TransactionResponse.
 */
export default function useTransact() {
  const { account, chainId } = useWeb3()
  const { addToast } = useToast()
  const [pending, setPending] = useState(false)

  const run = useCallback(
    async ({ label, send, successMessage, onSuccess }) => {
      setPending(true)
      let hash
      try {
        const tx = await send()
        hash = tx.hash
        addTransaction(chainId, account, { hash, label })
        const receipt = await tx.wait()
        if (receipt.status === 0) throw new Error('Transaction reverted on-chain')
        setTransactionStatus(chainId, account, hash, 'confirmed')
        addToast(successMessage || `${label} confirmed`, 'success')
        if (onSuccess) await onSuccess(receipt)
        return receipt
      } catch (e) {
        if (hash) {
          // replaced (speed-up/cancel) txs surface as errors with a replacement receipt
          if (e.replacement && e.receipt?.status === 1) {
            setTransactionStatus(chainId, account, hash, 'confirmed')
            addToast(successMessage || `${label} confirmed`, 'success')
            if (onSuccess) await onSuccess(e.receipt)
            return e.receipt
          }
          setTransactionStatus(chainId, account, hash, 'failed')
        }
        addToast(parseError(e, `${label} failed`), 'error')
        return null
      } finally {
        setPending(false)
      }
    },
    [account, chainId, addToast]
  )

  return { run, pending }
}
