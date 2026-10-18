import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import DataUnavailable from '../components/DataUnavailable'
import ExploreTokensTable, { ExploreTokensTableSkeleton } from '../components/ExploreTokensTable'
import ExplorePoolsTable, { ExplorePoolsTableSkeleton } from '../components/ExplorePoolsTable'
import { getFeatures } from '../lib/features'
import { getTokens, getPools, indexerErrorMessage } from '../lib/indexerApi'

const POOL_LIMIT = 100

export default function ExplorePage() {
  const features = getFeatures()
  const router = useRouter()
  // ?q= from a nav-search fallback: prefills both table filters once the
  // router has hydrated (router.query is empty on the first render).
  const initialQuery = typeof router.query.q === 'string' ? router.query.q : ''
  const [tokens, setTokens] = useState([])
  const [pools, setPools] = useState([])
  const [loading, setLoading] = useState(features.explore)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!features.explore) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => Promise.all([getTokens(), getPools({ limit: POOL_LIMIT })]))
      .then(([t, p]) => {
        if (!cancelled) {
          setTokens(Array.isArray(t) ? t : [])
          setPools(p && Array.isArray(p.pools) ? p.pools : [])
        }
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
  }, [features.explore])

  if (!features.explore) {
    return (
      <DataUnavailable
        title="Explore"
        needs="the Swapex indexer (set NEXT_PUBLIC_INDEXER_URL) on a network with Swapex deployed"
      />
    )
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Explore</h1>

      {error ? (
        <div role="alert" className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
          {indexerErrorMessage(error)}
        </div>
      ) : null}

      <section aria-labelledby="explore-tokens-heading">
        <h2 id="explore-tokens-heading" className="text-lg font-semibold mb-3">
          Tokens
        </h2>
        {loading ? (
          <ExploreTokensTableSkeleton />
        ) : (
          <ExploreTokensTable key={`tokens:${initialQuery}`} tokens={tokens} error={Boolean(error)} initialQuery={initialQuery} />
        )}
      </section>

      <section aria-labelledby="explore-pools-heading">
        <h2 id="explore-pools-heading" className="text-lg font-semibold mb-3">
          Pools
        </h2>
        {loading ? (
          <ExplorePoolsTableSkeleton />
        ) : (
          <ExplorePoolsTable key={`pools:${initialQuery}`} pools={pools} error={Boolean(error)} initialQuery={initialQuery} />
        )}
      </section>
    </div>
  )
}
