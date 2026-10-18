import React from 'react'
import Link from 'next/link'
import { useWeb3 } from '../context/Web3Context'
import usePositions from '../hooks/usePositions'
import DataUnavailable from './DataUnavailable'
import NetworkGuard from './NetworkGuard'
import Skeleton from './Skeleton'
import { DEPLOYMENT } from '../lib/config'
import { tickToPrice, formatPrice, usableRange, tickSpacingFor } from '../lib/ticks'

export function rangeLabel(p) {
  const { min, max } = usableRange(tickSpacingFor(p.fee))
  const lo = p.tickLower <= min ? '0' : formatPrice(tickToPrice(p.tickLower, p.token0.decimals, p.token1.decimals))
  const hi = p.tickUpper >= max ? '∞' : formatPrice(tickToPrice(p.tickUpper, p.token0.decimals, p.token1.decimals))
  return `${lo} – ${hi} ${p.token1.symbol} per ${p.token0.symbol}`
}

export function RangeBadge({ inRange, empty }) {
  const cls = empty
    ? 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)]'
    : inRange
    ? 'bg-[var(--success)]/10 text-[var(--success)]'
    : 'bg-yellow-500/10 text-yellow-500'
  return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{empty ? 'Closed' : inRange ? 'In range' : 'Out of range'}</span>
}

export default function PositionsList() {
  const { account } = useWeb3()
  const { positions, loading, error } = usePositions()

  if (!DEPLOYMENT) return <DataUnavailable title="Pools" needs="Swapex contracts deployed on this network" />

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Positions</h1>
        <Link href="/add" className="px-4 py-2 rounded-full bg-[var(--accent)] text-white text-sm font-medium no-underline hover:bg-[var(--accent-hover)]">
          New position
        </Link>
      </div>

      {!account ? (
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--bg-secondary)] p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)] mb-4">Connect a wallet to see your liquidity positions.</p>
          <NetworkGuard><span /></NetworkGuard>
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
          Could not load positions. Check your network connection and RPC, then reload.
        </div>
      ) : loading && positions.length === 0 ? (
        <div className="space-y-3" role="status" aria-label="Loading positions">
          <span className="sr-only">Loading positions…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="w-7 h-7 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-12 ml-auto" />
              </div>
              <Skeleton className="mt-3 h-3 w-40" />
            </div>
          ))}
        </div>
      ) : positions.length === 0 ? (
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--bg-secondary)] p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">You have no positions yet. Provide liquidity to earn trading fees.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {positions.map((p) => (
            <Link
              key={p.id}
              href={`/pool/${p.id}`}
              className="block rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 no-underline hover:border-[var(--accent)] transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-2">
                    <img src={p.token0.logo} alt="" className="w-7 h-7 rounded-full border border-[var(--bg-card)]" />
                    <img src={p.token1.logo} alt="" className="w-7 h-7 rounded-full border border-[var(--bg-card)]" />
                  </div>
                  <span className="font-medium text-[var(--text-primary)]">
                    {p.token0.symbol} / {p.token1.symbol}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{p.fee / 10000}%</span>
                </div>
                <RangeBadge inRange={p.inRange} empty={p.liquidity.isZero()} />
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
