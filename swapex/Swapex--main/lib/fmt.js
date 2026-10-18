// Small display formatters for the explore screens. Null/undefined always
// render as an honest dash — never a fabricated 0.
// Numbers/dates use a fixed en-US locale: the UI text is English, and pinned
// formatting keeps rendering (and tests) identical on every machine.

const NUM = 'en-US'

export function formatUsd(value, maxFrac = 2) {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  // sub-cent values keep their digits instead of collapsing to "$0"
  const frac = abs > 0 && abs < 0.01 ? Math.max(maxFrac, 6) : maxFrac
  return `$${value.toLocaleString(NUM, { maximumFractionDigits: frac })}`
}

/** Compact number for volumes/reserves: 1.2M, 34K… sub-1 keeps 3 significant digits. */
export function formatCompact(value, maxFrac = 2) {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs > 0 && abs < 1) return value.toLocaleString(NUM, { maximumSignificantDigits: maxFrac + 1 })
  if (abs >= 1e9) return `${(value / 1e9).toLocaleString(NUM, { maximumFractionDigits: maxFrac })}B`
  if (abs >= 1e6) return `${(value / 1e6).toLocaleString(NUM, { maximumFractionDigits: maxFrac })}M`
  if (abs >= 1e3) return `${(value / 1e3).toLocaleString(NUM, { maximumFractionDigits: maxFrac })}K`
  return value.toLocaleString(NUM, { maximumFractionDigits: maxFrac })
}

/** Signed percent from a fraction: 0.082 -> "+8.2%", null -> "—". */
export function formatPct(fraction, maxFrac = 2) {
  if (fraction == null || !Number.isFinite(fraction)) return '—'
  const pct = fraction * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toLocaleString(NUM, { maximumFractionDigits: maxFrac })}%`
}

/** 0x1234…abcd */
export function shortAddress(address) {
  if (!address) return '—'
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function formatTime(unixSec) {
  if (unixSec == null || !Number.isFinite(unixSec)) return '—'
  return new Date(unixSec * 1000).toLocaleString(NUM)
}
