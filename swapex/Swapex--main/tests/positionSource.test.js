import { describe, it, expect, vi } from 'vitest'
import { positionIdsFromRows, discoverPositionIds } from '../lib/positionSource'

const OWNER = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const ROW = (tokenId) => ({ tokenId, owner: OWNER, liquidityAdded: '1', liquidityRemoved: '0', feesCollected0Raw: '0', feesCollected1Raw: '0' })

describe('positionIdsFromRows', () => {
  it('maps tokenId strings in order', () => {
    expect(positionIdsFromRows([ROW('7'), ROW('12')])).toEqual(['7', '12'])
  })

  it('drops rows without a usable tokenId', () => {
    expect(positionIdsFromRows([{ tokenId: null }, { tokenId: '' }, {}, ROW('3')])).toEqual(['3'])
  })

  it('returns [] for non-arrays', () => {
    expect(positionIdsFromRows(null)).toEqual([])
    expect(positionIdsFromRows(undefined)).toEqual([])
    expect(positionIdsFromRows('nope')).toEqual([])
  })
})

describe('discoverPositionIds', () => {
  it('indexer rows + gap scan from cursor, deduped, source indexer', async () => {
    const fromIndexer = vi.fn().mockResolvedValue({ ids: ['1', '2'], gapFrom: 100 })
    const fromEvents = vi.fn().mockResolvedValue(['2', '3'])
    const res = await discoverPositionIds(OWNER, { fromIndexer, fromEvents })
    expect(res).toEqual({ ids: ['1', '2', '3'], source: 'indexer' })
    expect(fromEvents).toHaveBeenCalledExactlyOnceWith(OWNER, 100)
  })

  it('null gapFrom means no gap scan', async () => {
    const fromIndexer = vi.fn().mockResolvedValue({ ids: ['9'], gapFrom: null })
    const fromEvents = vi.fn()
    const res = await discoverPositionIds(OWNER, { fromIndexer, fromEvents })
    expect(res).toEqual({ ids: ['9'], source: 'indexer' })
    expect(fromEvents).not.toHaveBeenCalled()
  })

  it('indexer throwing (transport/HTTP/chain mismatch) -> full event scan', async () => {
    const fromIndexer = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const fromEvents = vi.fn().mockResolvedValue(['5'])
    const res = await discoverPositionIds(OWNER, { fromIndexer, fromEvents })
    expect(res).toEqual({ ids: ['5'], source: 'events' })
    expect(fromEvents).toHaveBeenCalledExactlyOnceWith(OWNER)
  })

  it('indexer returning null (not configured / wrong chain) -> full event scan', async () => {
    const fromIndexer = vi.fn().mockResolvedValue(null)
    const fromEvents = vi.fn().mockResolvedValue(['4'])
    const res = await discoverPositionIds(OWNER, { fromIndexer, fromEvents })
    expect(res).toEqual({ ids: ['4'], source: 'events' })
    expect(fromEvents).toHaveBeenCalledExactlyOnceWith(OWNER)
  })

  it('indexer returning no rows -> full event scan (cheap correctness answer)', async () => {
    const fromIndexer = vi.fn().mockResolvedValue({ ids: [], gapFrom: 100 })
    const fromEvents = vi.fn().mockResolvedValue(['1'])
    const res = await discoverPositionIds(OWNER, { fromIndexer, fromEvents })
    expect(res).toEqual({ ids: ['1'], source: 'events' })
    expect(fromEvents).toHaveBeenCalledExactlyOnceWith(OWNER)
  })

  it('without an indexer branch -> full event scan', async () => {
    const fromEvents = vi.fn().mockResolvedValue(['2'])
    const res = await discoverPositionIds(OWNER, { fromEvents })
    expect(res).toEqual({ ids: ['2'], source: 'events' })
    expect(fromEvents).toHaveBeenCalledExactlyOnceWith(OWNER)
  })
})
