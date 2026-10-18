import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import DataUnavailable from '../../../components/DataUnavailable'
import ExplorePoolsTable from '../../../components/ExplorePoolsTable'
import Skeleton from '../../../components/Skeleton'
import { getFeatures } from '../../../lib/features'
import { getTokens, getPools, indexerErrorMessage } from '../../../lib/indexerApi'
import { formatUsd, shortAddress } from '../../../lib/fmt'
import { tokenLogo } from '../../../lib/tokens'

const POOL_LIMIT = 100

export default function ExploreTokenPage() {
  const router = useRouter()
  const address = router.isReady ? String(router.query.address || '') : ''
  const features = getFeatures()
  const [token, setToken] = useState(null)
  const [pools, setPools] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!features.explore || !address) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => {
        setLoading(true)
        setError(null)
        return Promise.all([getTokens(), getPools({ limit: POOL_LIMIT })])
      })
      .then(([tokens, allPools]) => {
        if (cancelled) return
        const found = (tokens || []).find((t) => t.address.toLowerCase() === address.toLowerCase()) || null
        const containing = (allPools && allPools.pools ? allPools.pools : []).filter(
          (p) =>
            p.token0.address.toLowerCase() === address.toLowerCase() ||
            p.token1.address.toLowerCase() === address.toLowerCase()
        )
        setToken(found)
        setPools(containing)
      })
      .catch((e) => {
        if (!cancelled) setError(e)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [features.explore, address])

  if (!features.explore) {
    return <DataUnavailable title="Token" needs="the Swapex indexer (set NEXT_PUBLIC_INDEXER_URL) on a network with Swapex deployed" />
  }
  if (!router.isReady) return null

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/explore" className="text-sm text-[var(--text-secondary)] no-underline hover:text-[var(--accent)]">
        ← Back to explore
      </Link>

      {loading ? (
        <div role="status" aria-label="Loading token" className="space-y-3">
          <span className="sr-only">Loading token…</span>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
          {indexerErrorMessage(error)}
        </div>
      ) : !token ? (
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--bg-secondary)] p-8 text-center">
          <h1 className="text-lg font-semibold mb-2">Unknown token</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {shortAddress(address)} is not in the indexer&apos;s token list. It may have no pools yet.
          </p>
        </div>
      ) : (
        <>
          <header className="flex items-center gap-3">
            <img src={tokenLogo(token.symbol)} alt="" aria-hidden="true" className="w-10 h-10 rounded-full" />
            <div>
              <h1 className="text-2xl font-semibold">
                {token.symbol} <span className="text-base text-[var(--text-tertiary)] font-normal">{token.name}</span>
              </h1>
              <p className="text-xs font-mono text-[var(--text-tertiary)]">{token.address}</p>
            </div>
            <div className="ml-auto text-right">
              <p className="text-xs text-[var(--text-tertiary)]">Price</p>
              <p className="text-xl font-mono">{formatUsd(token.usdPrice)}</p>
            </div>
          </header>

          <div className="flex gap-3">
            <Link href="/swap" className="px-4 py-2 rounded-full bg-[var(--accent)] text-white text-sm font-medium no-underline hover:bg-[var(--accent-hover)]">
              Swap
            </Link>
            <Link href="/add" className="px-4 py-2 rounded-full border border-[var(--border)] text-sm font-medium no-underline text-[var(--text-primary)] hover:border-[var(--accent)]">
              Add liquidity
            </Link>
          </div>

          <section aria-labelledby="token-pools-heading">
            <h2 id="token-pools-heading" className="text-lg font-semibold mb-3">
              Pools with {token.symbol}
            </h2>
            {pools.length === 0 ? (
              <p className="text-sm text-[var(--text-tertiary)]">No pools indexed for this token yet.</p>
            ) : (
              <ExplorePoolsTable pools={pools} />
            )}
          </section>
        </>
      )}
    </div>
  )
}
