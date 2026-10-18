import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import DataUnavailable from '../../../components/DataUnavailable'
import PriceChart from '../../../components/PriceChart'
import Skeleton from '../../../components/Skeleton'
import { getFeatures } from '../../../lib/features'
import { getPool, getPoolSwaps, isNotFound, indexerErrorMessage } from '../../../lib/indexerApi'
import { formatUsd, formatCompact, formatPct, formatTime } from '../../../lib/fmt'
import { explorerTxUrl, REQUIRED_CHAIN_ID } from '../../../lib/config'

const SWAP_LIMIT = 25

export default function ExplorePoolPage() {
  const router = useRouter()
  const address = router.isReady ? String(router.query.address || '') : ''
  const features = getFeatures()
  const [pool, setPool] = useState(null)
  const [swaps, setSwaps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!features.explore || !address) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => {
        setLoading(true)
        setError(null)
        return Promise.all([getPool(address), getPoolSwaps(address, { limit: SWAP_LIMIT })])
      })
      .then(([p, s]) => {
        if (cancelled) return
        setPool(p)
        setSwaps(Array.isArray(s) ? s : [])
      })
      .catch((e) => {
        if (cancelled) return
        // 404 = this address is not an indexed pool -> "unknown" state, not an outage
        if (isNotFound(e)) {
          setPool(null)
          setSwaps([])
        } else {
          setError(e)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [features.explore, address])

  if (!features.explore) {
    return <DataUnavailable title="Pool" needs="the Swapex indexer (set NEXT_PUBLIC_INDEXER_URL) on a network with Swapex deployed" />
  }
  if (!router.isReady) return null

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/explore" className="text-sm text-[var(--text-secondary)] no-underline hover:text-[var(--accent)]">
        ← Back to explore
      </Link>

      {loading ? (
        <div role="status" aria-label="Loading pool" className="space-y-3">
          <span className="sr-only">Loading pool…</span>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-[220px] w-full rounded-xl" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
          {indexerErrorMessage(error)}
        </div>
      ) : !pool ? (
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--bg-secondary)] p-8 text-center">
          <h1 className="text-lg font-semibold mb-2">Unknown pool</h1>
          <p className="text-sm text-[var(--text-secondary)]">This address is not an indexed Swapex pool.</p>
        </div>
      ) : (
        <>
          <header className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">
                {pool.token0.symbol} / {pool.token1.symbol}
              </h1>
              <p className="text-xs font-mono text-[var(--text-tertiary)]">
                {(pool.fee / 10000).toFixed(4)}% fee · {pool.address}
              </p>
            </div>
            <div className="flex gap-3">
              <Link href="/swap" className="px-4 py-2 rounded-full bg-[var(--accent)] text-white text-sm font-medium no-underline hover:bg-[var(--accent-hover)]">
                Swap
              </Link>
              <Link href="/add" className="px-4 py-2 rounded-full border border-[var(--border)] text-sm font-medium no-underline text-[var(--text-primary)] hover:border-[var(--accent)]">
                Add liquidity
              </Link>
            </div>
          </header>

          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Price" value={formatUsd(pool.price)} />
            <Stat label="TVL" value={formatUsd(pool.tvlUsd, 0)} />
            <Stat label="Volume 24h" value={formatCompact(pool.volume24h)} />
            <Stat
              label="Change 24h"
              value={formatPct(pool.change24h)}
              valueClass={pool.change24h == null ? '' : pool.change24h >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}
            />
          </dl>

          <PriceChart poolAddress={pool.address} />

          <section aria-labelledby="pool-swaps-heading">
            <h2 id="pool-swaps-heading" className="text-lg font-semibold mb-3">
              Recent swaps
            </h2>
            {swaps.length === 0 ? (
              <p className="text-sm text-[var(--text-tertiary)]">No swaps indexed for this pool yet.</p>
            ) : (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-x-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-tertiary)]">
                      <th className="px-4 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">{pool.token0.symbol} amount</th>
                      <th className="px-4 py-3 font-medium">{pool.token1.symbol} amount</th>
                      <th className="px-4 py-3 font-medium">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {swaps.map((s, i) => {
                      const href = explorerTxUrl(REQUIRED_CHAIN_ID, s.txHash)
                      return (
                        <tr key={`${s.txHash}-${i}`} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-4 py-3 text-[var(--text-secondary)]">{formatTime(s.timestamp)}</td>
                          <td className="px-4 py-3 font-mono text-[var(--text-primary)]">{formatCompact(s.amount0)}</td>
                          <td className="px-4 py-3 font-mono text-[var(--text-primary)]">{formatCompact(s.amount1)}</td>
                          <td className="px-4 py-3">
                            {href ? (
                              <a href={href} target="_blank" rel="noreferrer" className="font-mono text-xs text-[var(--accent)] no-underline hover:underline">
                                {s.txHash.slice(0, 10)}…
                              </a>
                            ) : (
                              <span className="font-mono text-xs text-[var(--text-tertiary)]">{s.txHash.slice(0, 10)}…</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, valueClass = '' }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <dt className="text-xs text-[var(--text-tertiary)]">{label}</dt>
      <dd className={`mt-1 text-lg font-mono ${valueClass || 'text-[var(--text-primary)]'}`}>{value}</dd>
    </div>
  )
}
