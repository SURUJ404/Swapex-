import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, getCursor, setCursor, insertEvents, insertPool, poolAddresses, deleteEventsAfter, type Db, type StoredEvent } from '../src/db'

function ev(logId: string, blockNumber: number, event = 'Swap'): StoredEvent {
  return {
    logId,
    blockNumber,
    blockHash: '0x' + '11'.repeat(32),
    txHash: '0x' + '22'.repeat(32),
    logIndex: 0,
    address: '0x' + '33'.repeat(20),
    event,
    args: '{}',
  }
}

describe('db', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('cursor starts null and round-trips', () => {
    expect(getCursor(db)).toBeNull()
    setCursor(db, 5)
    expect(getCursor(db)).toBe(5)
    setCursor(db, 10)
    expect(getCursor(db)).toBe(10)
  })

  it('insertEvents is idempotent on log id', () => {
    expect(insertEvents(db, [ev('0xaaa:0', 1)])).toBe(1)
    expect(insertEvents(db, [ev('0xaaa:0', 1)])).toBe(0)
    expect(insertEvents(db, [ev('0xaaa:0', 1), ev('0xbbb:0', 1)])).toBe(1)
  })

  it('pools are stored lowercased and deduped', () => {
    insertPool(db, {
      address: '0xAbC0000000000000000000000000000000000001',
      token0: '0xAbC0000000000000000000000000000000000002',
      token1: '0xAbC0000000000000000000000000000000000003',
      fee: 3000,
      tickSpacing: 60,
      createdBlock: 3,
    })
    insertPool(db, {
      address: '0xabc0000000000000000000000000000000000001',
      token0: '0xabc0000000000000000000000000000000000002',
      token1: '0xabc0000000000000000000000000000000000003',
      fee: 3000,
      tickSpacing: 60,
      createdBlock: 3,
    })
    expect(poolAddresses(db)).toEqual(['0xabc0000000000000000000000000000000000001'])
  })

  it('deleteEventsAfter rolls back events and pools past a block', () => {
    insertEvents(db, [ev('a:0', 4), ev('b:0', 8)])
    insertPool(db, {
      address: '0x' + 'aa'.repeat(20),
      token0: '0x' + 'bb'.repeat(20),
      token1: '0x' + 'cc'.repeat(20),
      fee: 500,
      tickSpacing: 10,
      createdBlock: 9,
    })
    deleteEventsAfter(db, 5)
    const rows = db.prepare('SELECT log_id FROM events ORDER BY log_id').all() as { log_id: string }[]
    expect(rows.map((r) => r.log_id)).toEqual(['a:0'])
    expect(poolAddresses(db)).toEqual([])
  })
})
