import React, { useState, useEffect } from 'react'
import { DialogOverlay, DialogContent } from '@reach/dialog'
import '@reach/dialog/styles.css'
import { findToken } from '../lib/tokens'
import { formatAmount, bpsToPercent } from '../lib/amounts'
import { formatRate, impactPercent, needsExtraConfirm, feeEstimateEth } from '../lib/review'

function Row({ k, v, danger }) {
  return (
    <div className="flex justify-between text-sm py-1">
      <span className="text-[var(--text-tertiary)]">{k}</span>
      <span className={`font-mono ${danger ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'}`}>{v}</span>
    </div>
  )
}

/**
 * Swap review modal. Pure summary: every value is passed in; confirming calls onConfirm
 * (the widget keeps running the existing useTransact flow). Impact at or above 5% needs
 * a second, explicit confirm.
 */
export default function ConfirmSwapModal({
  open,
  onClose,
  onConfirm,
  pending,
  inputToken,
  outputToken,
  amountIn,
  amountOut,
  minReceived,
  route,
  impact,
  slippageBps,
  deadlineMin,
  gasEstimate,
  gasPrice,
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    if (!open) {
      Promise.resolve()
        .then(() => setAcknowledged(false))
        .catch(() => {})
    }
  }, [open])

  const extra = needsExtraConfirm(impact)
  const rate = formatRate(amountIn, inputToken?.decimals, amountOut, outputToken?.decimals)
  const fee = feeEstimateEth(gasEstimate, gasPrice)

  const handleConfirm = () => {
    if (extra && !acknowledged) {
      setAcknowledged(true)
      return
    }
    onConfirm()
  }

  return (
    <DialogOverlay isOpen={open} onDismiss={pending ? () => {} : onClose} className="z-50">
      <DialogContent
        aria-label="Confirm swap"
        className="!bg-[var(--bg-card)] !border !border-[var(--border)] !rounded-2xl !p-0 !w-full !max-w-sm !m-4"
      >
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold font-display text-[var(--text-primary)]">Confirm swap</h2>
            <button
              onClick={onClose}
              disabled={pending}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-xl disabled:opacity-40"
            >
              &times;
            </button>
          </div>

          <div className="rounded-xl bg-[var(--bg-secondary)] p-3 mb-3">
            <Row k="You pay" v={`${formatAmount(amountIn, inputToken?.decimals, 8)} ${inputToken?.symbol}`} />
            <Row k="You receive" v={`${formatAmount(amountOut, outputToken?.decimals, 8)} ${outputToken?.symbol}`} />
          </div>

          <div className="mb-3">
            {rate && <Row k="Rate" v={`1 ${inputToken?.symbol} = ${rate} ${outputToken?.symbol}`} />}
            <Row
              k="Price impact"
              v={impactPercent(impact)}
              danger={extra}
            />
            <Row
              k="Minimum received"
              v={`${formatAmount(minReceived, outputToken?.decimals, 8)} ${outputToken?.symbol}`}
            />
            <Row k="Slippage tolerance" v={`${bpsToPercent(slippageBps)}%`} />
            <Row k="Transaction deadline" v={`${deadlineMin} min`} />
            {route?.fees?.length > 0 && (
              <Row
                k="Route"
                v={route.tokens
                  .map((a, i) => {
                    const sym = findToken(a)?.symbol || `${a.slice(0, 6)}…`
                    const feeTier = route.fees[i] ? ` (${route.fees[i] / 10000}%)` : ''
                    return `${sym}${feeTier}`
                  })
                  .join(' → ')}
              />
            )}
            <Row k="Estimated network fee" v={fee == null ? 'n/a' : `${fee} ETH`} />
          </div>

          {extra && !acknowledged && (
            <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3 mb-3 text-xs text-yellow-500">
              Price impact is high (5% or more). You will receive noticeably less than the quoted rate.
              Press <span className="font-semibold">Confirm anyway</span> only if you understand.
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={pending}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:opacity-90 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={pending}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:cursor-wait ${
                extra && !acknowledged
                  ? 'bg-[var(--danger)] hover:opacity-90'
                  : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)]'
              }`}
            >
              {pending ? 'Swapping…' : extra && !acknowledged ? 'Confirm anyway' : 'Confirm swap'}
            </button>
          </div>
        </div>
      </DialogContent>
    </DialogOverlay>
  )
}
