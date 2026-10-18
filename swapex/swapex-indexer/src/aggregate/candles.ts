// OHLCV candles from Swap events. Prices come from each swap's sqrtPriceX96
// (token1 per token0, raw units), decimal-adjusted here so API consumers get
// human-scale numbers.

export const CANDLE_INTERVALS = ['1H', '1D'] as const
export type CandleInterval = (typeof CANDLE_INTERVALS)[number]

const INTERVAL_SECONDS: Record<CandleInterval, number> = { '1H': 3600, '1D': 86400 }

export interface SwapPoint {
  timestamp: number // unix seconds
  sqrtPriceX96: bigint
  amount0: bigint // raw, absolute token0 traded
}

export interface Candle {
  time: number // bucket start, unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number // token0 units traded in the bucket
}

/** (sqrtPriceX96)^2 / 2^192, scaled by decimal difference -> token1 per token0. */
export function priceOf(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const raw = Number(sqrtPriceX96) / 2 ** 96
  return raw * raw * 10 ** (decimals0 - decimals1)
}

export function buildCandles(
  swaps: SwapPoint[],
  interval: CandleInterval,
  decimals0: number,
  decimals1: number
): Candle[] {
  const step = INTERVAL_SECONDS[interval] ?? 3600
  const sorted = [...swaps].sort((a, b) => a.timestamp - b.timestamp)
  const buckets = new Map<number, Candle>()

  for (const s of sorted) {
    const time = Math.floor(s.timestamp / step) * step
    const price = priceOf(s.sqrtPriceX96, decimals0, decimals1)
    const vol = Number(s.amount0) / 10 ** decimals0
    const existing = buckets.get(time)
    if (!existing) {
      buckets.set(time, {
        time,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: vol,
      })
    } else {
      existing.high = Math.max(existing.high, price)
      existing.low = Math.min(existing.low, price)
      existing.close = price
      existing.volume += vol
    }
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time)
}
