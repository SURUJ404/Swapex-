import React from 'react'
import Link from 'next/link'
import usePositions from '../hooks/usePositions'
import { useWeb3 } from '../context/Web3Context'
import { DEPLOYMENT } from '../lib/config'
import { RangeBadge, rangeLabel } from './PositionsList'
import Skeleton from './Skeleton'

/** The connected account's liquidity positions, with skeleton/empty/error states. */
export default function PortfolioPositions() {
  const { account } = useWeb3()
  const { positions, loading, error } = usePositions()

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
      <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">Positions</h2>

      {!account ? (
        <p className="text-sm text-[var(--text-secondary)]">Connect a wallet to see your positions.</p>
      ) : !DEPLOYMENT ? (
        <p className="text-sm text-[var(--text-secondary)]">Swapex is not deployed on this network.</p>
      ) : error ? (
        <div role="alert" className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
          Could not load positions. Check your network connection and RPC, then reload.
        </div>
      ) : loading && positions.length === 0 ? (
        <div className="space-y-3" role="status" aria-label="Loading positions">
          <span className="sr-only">Loading positions…</span>
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl border border-[var(--border)] p-4 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      ) : positions.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">You have no positions yet. Provide liquidity to earn trading fees.</p>
      ) : (
        <div className="space-y-3">
          {positions.map((p) => (
            <Link
              key={p.id}
              href={`/pool/${p.id}`}
              className="block rounded-xl border border-[var(--border)] p-4 no-underline hover:border-[var(--accent)] transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-2">
                    <img src={p.token0.logo} alt="" aria-hidden="true" className="w-7 h-7 rounded-full border border-[var(--bg-card)]" />
                    <img src={p.token1.logo} alt="" aria-hidden="true" className="w-7 h-7 rounded-full border border-[var(--bg-card)]" />
                  </div>
                  <span className="font-medium text-[var(--text-primary)]">
                    {p.token0.symbol} / {p.token1.symbol}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{p.fee / 10000}%</span>
                </div>
                <RangeBadge inRange={p.inRange} empty={p.liquidity === 0n} />
              </div>
              <div className="mt-2 text-xs text-[var(--text-tertiary)] font-mono">
                #{p.id} · {rangeLabel(p)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
