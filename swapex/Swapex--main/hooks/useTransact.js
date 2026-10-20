import { useState, useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { useToast } from '../components/Toast'
import { parseError } from '../lib/errors'
import { addTransaction, setTransactionStatus } from '../lib/txHistory'

/**
 * Runs a transaction-sending function with consistent behavior:
 * pending entry in history, wait for receipt, status update, friendly errors.
 * `send` must return the transaction hash (viem writeContract / sendTransaction result).
 */
export default function useTransact() {
  const { account, chainId, clients } = useWeb3()
  const { addToast } = useToast()
  const [pending, setPending] = useState(false)

  const run = useCallback(
    async ({ label, send, successMessage, onSuccess }) => {
      setPending(true)
      let hash
      try {
        hash = await send()
        addTransaction(chainId, account, { hash, label })
        const receipt = await clients.public.waitForTransactionReceipt({ hash })
        if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain')
        setTransactionStatus(chainId, account, hash, 'confirmed')
        addToast(successMessage || `${label} confirmed`, 'success')
        if (onSuccess) await onSuccess(receipt)
        return receipt
      } catch (e) {
        if (hash) {
          // replaced (speed-up/cancel) txs surface as TransactionReplacementError with a receipt
          if (e?.name === 'TransactionReplacementError' && e.receipt?.status === 'success') {
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
    [account, chainId, clients, addToast]
  )

  return { run, pending }
}
