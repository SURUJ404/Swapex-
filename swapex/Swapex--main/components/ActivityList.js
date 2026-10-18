import React, { useState, useEffect } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { getTransactions } from '../lib/txHistory'
import { explorerTxUrl } from '../lib/config'

/**
 * Activity for the connected account. Today this is the local transaction log
 * (swaps/mints/collections submitted from this browser). Indexer-sourced swaps
 * are added when the indexer API lands (S19/S20); nothing here is fabricated.
 */
export default function ActivityList() {
  const { account, chainId } = useWeb3()
  const [txs, setTxs] = useState([])

  useEffect(() => {
    const load = () => setTxs(getTransactions(chainId, account))
    load()
    window.addEventListener('swapex-tx', load)
    return () => window.removeEventListener('swapex-tx', load)
  }, [account, chainId])

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
      <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">Activity</h2>

      {!account ? (
        <p className="text-sm text-[var(--text-secondary)]">Connect a wallet to see your activity.</p>
      ) : txs.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">
          No activity yet from this browser. Transactions you submit appear here.
        </p>
      ) : (
        <div className="space-y-2">
          {txs
            .slice()
            .reverse()
            .map((tx) => (
              <div key={tx.hash} className="flex items-center justify-between py-2 border-b border-[var(--border)]/50 last:border-0">
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
                  {explorerTxUrl(chainId, tx.hash) && (
                    <a
                      href={explorerTxUrl(chainId, tx.hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[var(--accent)] hover:underline"
                    >
                      View
                    </a>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
