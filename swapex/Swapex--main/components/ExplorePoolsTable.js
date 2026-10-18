import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import Skeleton from './Skeleton'
import { formatUsd, formatCompact, formatPct } from '../lib/fmt'

const COLUMNS = [
  { key: 'pair', label: 'Pool', sortable: true },
  { key: 'fee', label: 'Fee', sortable: true },
  { key: 'price', label: 'Price', sortable: true },
  { key: 'tvlUsd', label: 'TVL', sortable: true },
  { key: 'volume24h', label: 'Volume 24h', sortable: true },
  { key: 'change24h', label: 'Change 24h', sortable: true },
  { key: 'txCount24h', label: 'Trades 24h', sortable: true },
]

function pairLabel(pool) {
  return `${pool.token0.symbol} / ${pool.token1.symbol}`
}

/** `weth/tusdc` and `WETH / tUSDC` compare equal: ignore case and separators. */
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Sortable, searchable pool table fed by indexer /pools. Pure presentation:
 * the page owns fetching and the loading/error states. `initialQuery` prefills
 * the filter (e.g. /explore?q= from a nav-search fallback); the page remounts
 * this component via a key when the URL query changes.
 */
export default function ExplorePoolsTable({ pools, error = false, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery)
  const [sort, setSort] = useState({ key: 'tvlUsd', dir: 'desc' })

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = pools
    if (q) {
      const nq = normalize(q)
      list = list.filter(
        (p) =>
          pairLabel(p).toLowerCase().includes(q) ||
          (nq && normalize(pairLabel(p)).includes(nq)) ||
          p.address.toLowerCase().includes(q) ||
          p.token0.address.toLowerCase().includes(q) ||
          p.token1.address.toLowerCase().includes(q)
      )
    }
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = sort.key === 'pair' ? pairLabel(a) : a[sort.key]
      const bv = sort.key === 'pair' ? pairLabel(b) : b[sort.key]
      if (typeof av === 'number' && typeof bv === 'number') {
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        return (av - bv) * dir
      }
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [pools, query, sort])

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  return (
    <div>
      <label className="block mb-3">
        <span className="sr-only">Search pools</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by pair or address"
          className="w-full rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </label>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-tertiary)]">
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-4 py-3 font-medium">
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
                      aria-label={`Sort by ${c.label}`}
                    >
                      {c.label}
                      <span aria-hidden="true">{sort.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-4 py-8 text-center text-[var(--text-tertiary)]">
                  {error ? 'Pools could not be loaded.' : pools.length === 0 ? 'No pools indexed yet.' : 'No pools match your search.'}
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.address} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-3">
                    <Link href={`/explore/pools/${p.address}`} className="font-medium text-[var(--text-primary)] no-underline hover:text-[var(--accent)]">
                      {pairLabel(p)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{(p.fee / 10000).toFixed(4)}%</td>
                  <td className="px-4 py-3 font-mono text-[var(--text-primary)]">{formatUsd(p.price)}</td>
                  <td className="px-4 py-3 font-mono text-[var(--text-primary)]">{formatUsd(p.tvlUsd, 0)}</td>
                  <td className="px-4 py-3 font-mono text-[var(--text-secondary)]">{formatCompact(p.volume24h)}</td>
                  <td className={`px-4 py-3 font-mono ${p.change24h == null ? 'text-[var(--text-tertiary)]' : p.change24h >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                    {formatPct(p.change24h)}
                  </td>
                  <td className="px-4 py-3 font-mono text-[var(--text-secondary)]">{p.txCount24h ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Skeleton rows for the pool table while the indexer request is in flight. */
export function ExplorePoolsTableSkeleton({ rows = 6 }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 space-y-3" role="status" aria-label="Loading pools">
      <span className="sr-only">Loading pools…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-16 ml-auto" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  )
}
