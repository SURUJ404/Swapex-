// Hand-rolled line-chart math for PriceChart (no chart library, per plan S21).
// Pure functions: series building from candles, coordinate scaling, path string.

export const CHART_RANGES = ['1D', '1W', '1M']

const RANGE_SECONDS = { '1D': 86400, '1W': 604800, '1M': 2592000 }

/** { from, to } window (unix seconds) for a chart range. */
export function timeRangeFor(range, nowSec = Math.floor(Date.now() / 1000)) {
  const span = RANGE_SECONDS[range] ?? RANGE_SECONDS['1D']
  return { from: nowSec - span, to: nowSec }
}

/**
 * Close-price series from candles, sorted by time and window-filtered:
 * [{ x: time, y: close }]. Non-finite closes are dropped (honest data only).
 */
export function seriesFromCandles(candles, { from, to } = {}) {
  if (!Array.isArray(candles)) return []
  let list = [...candles].sort((a, b) => a.time - b.time)
  if (from != null) list = list.filter((c) => c.time >= from)
  if (to != null) list = list.filter((c) => c.time <= to)
  return list
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
    .map((c) => ({ x: c.time, y: c.close }))
}

/**
 * Map series into an SVG box (SVG y grows downward). Flat or single-point
 * series render as a centered horizontal line, never NaN.
 */
export function scalePoints(series, { width, height, padX = 8, padY = 10 } = {}) {
  if (!series || series.length === 0) return []
  const xs = series.map((p) => p.x)
  const ys = series.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const innerW = Math.max(1, width - padX * 2)
  const innerH = Math.max(1, height - padY * 2)
  const midY = padY + innerH / 2
  return series.map((p) => {
    const x = maxX === minX ? padX + innerW / 2 : padX + ((p.x - minX) / (maxX - minX)) * innerW
    const y = maxY === minY ? midY : padY + (1 - (p.y - minY) / (maxY - minY)) * innerH
    return { x, y }
  })
}

function round(n) {
  return Math.round(n * 100) / 100
}

/** SVG path string: "M x y L x y …". Empty input -> empty string. */
export function pathFrom(points) {
  if (!points || points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ')
}
