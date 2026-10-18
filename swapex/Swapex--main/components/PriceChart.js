import React, { useEffect, useState } from 'react'
import Skeleton from './Skeleton'
import { getPoolCandles } from '../lib/indexerApi'
import { CHART_RANGES, timeRangeFor, seriesFromCandles, scalePoints, pathFrom } from '../lib/chart'
import { formatUsd } from '../lib/fmt'

const WIDTH = 640
const HEIGHT = 220

const RANGE_META = {
  '1D': { interval: '1H', label: '1D' },
  '1W': { interval: '1D', label: '1W' },
  '1M': { interval: '1D', label: '1M' },
}

/**
 * Hand-rolled SVG price line from indexer candles (close price). Honest states:
 * skeleton while loading, error banner on failure, "no swaps" when empty.
 */
export default function PriceChart({ poolAddress }) {
  const [range, setRange] = useState('1D')
  const [candles, setCandles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const interval = RANGE_META[range].interval
    Promise.resolve()
      .then(() => {
        setLoading(true)
        setError(null)
        return getPoolCandles(poolAddress, interval)
      })
      .then((c) => {
        if (!cancelled) setCandles(Array.isArray(c) ? c : [])
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
  }, [poolAddress, range])

  const window_ = timeRangeFor(range)
  const series = seriesFromCandles(candles, window_)
  const points = scalePoints(series, { width: WIDTH, height: HEIGHT })
  const path = pathFrom(points)
  const closes = series.map((p) => p.y)
  const low = closes.length ? Math.min(...closes) : null
  const high = closes.length ? Math.max(...closes) : null
  const first = series[0]
  const last = series[series.length - 1]

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">Price</h2>
        <div className="flex gap-1" role="group" aria-label="Chart range">
          {CHART_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              aria-pressed={r === range}
              className={`text-xs px-2 py-1 rounded-full ${
                r === range
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {RANGE_META[r].label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-[220px] w-full rounded-xl" />
      ) : error ? (
        <div
          role="alert"
          className="h-[220px] flex items-center justify-center rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-bg)] text-sm text-[var(--danger)]"
        >
          Could not load price history. The indexer may be down.
        </div>
      ) : series.length === 0 ? (
        <div className="h-[220px] flex items-center justify-center rounded-xl bg-[var(--bg-secondary)] text-sm text-[var(--text-tertiary)]">
          No swaps in this window yet.
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="w-full h-[220px]"
            role="img"
            aria-label={`Price chart, ${range} range, ${series.length} points`}
          >
            <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
          </svg>
          <div className="flex justify-between mt-2 text-xs text-[var(--text-tertiary)] font-mono">
            <span>
              {low != null ? `L ${formatUsd(low)}` : ''}
              {high != null ? ` · H ${formatUsd(high)}` : ''}
            </span>
            <span>
              {first && last && first.x !== last.x ? `${new Date(first.x * 1000).toLocaleDateString()} → ${new Date(last.x * 1000).toLocaleDateString()}` : ''}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
