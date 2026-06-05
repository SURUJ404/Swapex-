import React, { useState, useEffect } from 'react'

const STORAGE_KEY = 'swapex_transactions'

export default function TransactionHistory() {
  const [txs, setTxs] = useState([])

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
      setTxs(stored)
    } catch {
      setTxs([])
    }
  }, [])

  const etherscanLink = (hash) => `https://etherscan.io/tx/${hash}`

  if (txs.length === 0) return null

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
      <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">Transaction History</h2>
      <div className="space-y-2">
        {txs.slice().reverse().map((tx, i) => (
          <div key={i} className="flex items-center justify-between py-2 border-b border-[var(--border)]/50 last:border-0">
            <div className="flex flex-col">
              <span className="text-sm text-[var(--text-primary)]">{tx.label || 'Transaction'}</span>
              <span className="text-xs text-[var(--text-tertiary)] font-mono">
                {tx.hash.slice(0, 10)}...{tx.hash.slice(-8)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  tx.status === 'confirmed'
                    ? 'bg-[var(--success)]/10 text-[var(--success)]'
                    : tx.status === 'pending'
                    ? 'bg-yellow-500/10 text-yellow-500'
                    : 'bg-[var(--danger-bg)] text-[var(--danger)]'
                }`}
              >
                {tx.status}
              </span>
              <a
                href={etherscanLink(tx.hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--accent)] hover:underline"
              >
                View
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
