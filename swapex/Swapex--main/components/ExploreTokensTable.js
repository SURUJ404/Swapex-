import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import Skeleton from './Skeleton'
import { formatUsd, shortAddress } from '../lib/fmt'
import { tokenLogo } from '../lib/tokens'

const COLUMNS = [
  { key: 'symbol', label: 'Token', sortable: true },
  { key: 'usdPrice', label: 'Price', sortable: true },
  { key: 'address', label: 'Address', sortable: false },
]

/**
 * Sortable, searchable token table fed by indexer /tokens. Pure presentation:
 * the page owns fetching and the loading/error states. `initialQuery` prefills
 * the filter (e.g. /explore?q= from a nav-search fallback); the page remounts
 * this component via a key when the URL query changes.
 */
export default function ExploreTokensTable({ tokens, error = false, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery)
  const [sort, setSort] = useState({ key: 'symbol', dir: 'asc' })

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = tokens
    if (q) {
      list = list.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q)
      )
    }
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      if (typeof av === 'number' && typeof bv === 'number') {
        // null prices always sort last, regardless of direction
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        return (av - bv) * dir
      }
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [tokens, query, sort])

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  return (
    <div>
      <label className="block mb-3">
        <span className="sr-only">Search tokens</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by symbol, name or address"
          className="w-full rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </label>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <table className="w-full text-sm">
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
                  {error ? 'Tokens could not be loaded.' : tokens.length === 0 ? 'No tokens indexed yet.' : 'No tokens match your search.'}
                </td>
              </tr>
            ) : (
              rows.map((t) => (
                <tr key={t.address} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-3">
                    <Link href={`/explore/tokens/${t.address}`} className="flex items-center gap-2 text-[var(--text-primary)] no-underline hover:text-[var(--accent)]">
                      <img src={tokenLogo(t.symbol)} alt="" aria-hidden="true" className="w-6 h-6 rounded-full" />
                      <span className="font-medium">{t.symbol}</span>
                      <span className="text-xs text-[var(--text-tertiary)]">{t.name}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-[var(--text-primary)]">{formatUsd(t.usdPrice)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--text-tertiary)]">{shortAddress(t.address)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Skeleton rows for the token table while the indexer request is in flight. */
export function ExploreTokensTableSkeleton({ rows = 6 }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 space-y-3" role="status" aria-label="Loading tokens">
      <span className="sr-only">Loading tokens…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="w-6 h-6 rounded-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16 ml-auto" />
        </div>
      ))}
    </div>
  )
}
