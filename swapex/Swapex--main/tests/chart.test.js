import { describe, it, expect } from 'vitest'
import { timeRangeFor, seriesFromCandles, scalePoints, pathFrom, CHART_RANGES } from '../lib/chart'

const NOW = 1_700_000_000

const candle = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 })

describe('timeRangeFor', () => {
  it('returns windows of the expected span', () => {
    expect(timeRangeFor('1D', NOW)).toEqual({ from: NOW - 86400, to: NOW })
    expect(timeRangeFor('1W', NOW)).toEqual({ from: NOW - 604800, to: NOW })
    expect(timeRangeFor('1M', NOW)).toEqual({ from: NOW - 2592000, to: NOW })
  })

  it('falls back to 1D for an unknown range', () => {
    expect(timeRangeFor('9X', NOW)).toEqual({ from: NOW - 86400, to: NOW })
  })
})

describe('seriesFromCandles', () => {
  it('sorts, windows and keeps only close prices', () => {
    const series = seriesFromCandles(
      [candle(NOW - 100, 3), candle(NOW - 300, 1), candle(NOW - 200, 2)],
      { from: NOW - 250, to: NOW }
    )
    expect(series).toEqual([
      { x: NOW - 200, y: 2 },
      { x: NOW - 100, y: 3 },
    ])
  })

  it('drops non-finite points and handles junk input', () => {
    expect(seriesFromCandles(null)).toEqual([])
    expect(seriesFromCandles([{ time: NOW, close: NaN }])).toEqual([])
    expect(seriesFromCandles([{ time: 'x', close: 1 }])).toEqual([])
  })
})

describe('scalePoints', () => {
  it('maps into the padded box, newest at the right, higher price higher up', () => {
    const pts = scalePoints(
      [
        { x: 0, y: 10 },
        { x: 100, y: 20 },
      ],
      { width: 200, height: 100, padX: 10, padY: 10 }
    )
    expect(pts).toHaveLength(2)
    expect(pts[0].x).toBeCloseTo(10, 6)
    expect(pts[1].x).toBeCloseTo(190, 6)
    // SVG y is inverted: the higher price is at the smaller y
    expect(pts[0].y).toBeCloseTo(90, 6)
    expect(pts[1].y).toBeCloseTo(10, 6)
  })

  it('centers a flat series instead of dividing by zero', () => {
    const pts = scalePoints([{ x: 5, y: 7 }], { width: 100, height: 50, padX: 0, padY: 0 })
    expect(pts).toEqual([{ x: 50, y: 25 }])
    const flat = scalePoints(
      [
        { x: 0, y: 7 },
        { x: 10, y: 7 },
      ],
      { width: 100, height: 50, padX: 0, padY: 0 }
    )
    expect(flat[0].y).toBe(25)
    expect(flat[1].y).toBe(25)
  })

  it('returns [] for empty series', () => {
    expect(scalePoints([], { width: 100, height: 50 })).toEqual([])
  })

  it('stays inside the padded box for out-of-order input', () => {
    const pts = scalePoints(
      [
        { x: 50, y: 1 },
        { x: 0, y: 5 },
        { x: 25, y: 3 },
      ],
      { width: 80, height: 40, padX: 4, padY: 4 }
    )
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(4)
      expect(p.x).toBeLessThanOrEqual(76)
      expect(p.y).toBeGreaterThanOrEqual(4)
      expect(p.y).toBeLessThanOrEqual(36)
    }
  })
})

describe('pathFrom', () => {
  it('builds an M/L path and rounds to 2 decimals', () => {
    expect(pathFrom([{ x: 1.23456, y: 2 }, { x: 3, y: 4.56789 }])).toBe('M1.23 2 L3 4.57')
  })

  it('returns empty string for no points', () => {
    expect(pathFrom([])).toBe('')
    expect(pathFrom(null)).toBe('')
  })
})

describe('CHART_RANGES', () => {
  it('is exactly 1D/1W/1M', () => {
    expect(CHART_RANGES).toEqual(['1D', '1W', '1M'])
  })
})
