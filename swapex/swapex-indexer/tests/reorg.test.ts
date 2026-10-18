import { describe, it, expect, beforeEach } from 'vitest'
import { parseAbi, encodeEventTopics, encodeAbiParameters, type Abi, type AbiEvent, type Log } from 'viem'
import { openDb, getCursor, type Db } from '../src/db'
import { runOnce } from '../src/indexer'
import { checkAndRollback } from '../src/reorg'
import { ALL_EVENTS } from '../src/abis'
import type { Manifest } from '../src/deployment'

const ABI = parseAbi(ALL_EVENTS as readonly string[]) as Abi
const MANIFEST: Manifest = {
  chainId: 31337,
  blockNumber: 0,
  factory: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  positionManager: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
}
const POOL = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ZERO = '0x0000000000000000000000000000000000000000'

function pickEvent(eventName: string): AbiEvent {
  const hit = ABI.find((i): i is AbiEvent => i.type === 'event' && i.name === eventName)
  if (!hit) throw new Error(`no ${eventName} event`)
  return hit
}

function encodeLog(event: AbiEvent, args: Record<string, unknown>, address: string, blockNumber: number, logIndex = 0): Log {
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args: args as never })
  const nonIndexed = event.inputs.filter((i) => !i.indexed)
  const data = encodeAbiParameters(
    nonIndexed.map((i) => ({ type: i.type, name: i.name })),
    nonIndexed.map((i) => args[i.name!] as never)
  )
  return {
    address,
    data,
    topics,
    blockNumber: BigInt(blockNumber),
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: '0x' + blockNumber.toString(16).padStart(64, '0') + logIndex.toString(16).padStart(2, '0'),
    transactionIndex: 0,
    logIndex,
    removed: false,
  } as Log
}

function poolCreatedLog(blockNumber: number): Log {
  return encodeLog(
    pickEvent('PoolCreated'),
    { token0: ZERO, token1: ALICE, fee: 3000, tickSpacing: 60, pool: POOL },
    MANIFEST.factory,
    blockNumber
  )
}

function swapLog(blockNumber: number, recipient = ALICE): Log {
  return encodeLog(
    pickEvent('Swap'),
    {
      sender: ALICE,
      recipient,
      amount0: BigInt(blockNumber),
      amount1: -1n,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1n,
      tick: 0,
    },
    POOL,
    blockNumber
  )
}

function defaultHash(n: number): string {
  return '0x' + n.toString(16).padStart(64, 'a')
}

/** Stub chain; hashes map overrides canonical block hashes to simulate a reorg. */
function chainStub(logs: Log[], head: number, hashes: Map<number, string> = new Map()) {
  return {
    getBlockNumber: async () => BigInt(head),
    getLogs: async ({
      address,
      fromBlock,
      toBlock,
    }: {
      address?: string | string[]
      fromBlock: bigint
      toBlock: bigint
    }) => {
      const addresses = (Array.isArray(address) ? address : address ? [address] : []).map((a) => a.toLowerCase())
      return logs.filter(
        (l) =>
          addresses.includes(l.address.toLowerCase()) &&
          l.blockNumber! >= fromBlock &&
          l.blockNumber! <= toBlock
      )
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      hash: hashes.get(Number(blockNumber)) ?? defaultHash(Number(blockNumber)),
      parentHash: '0x' + '00'.repeat(32),
    }),
  }
}

describe('reorg safety', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('no reorg: rollback is a no-op', async () => {
    await runOnce(chainStub([poolCreatedLog(1), swapLog(3)], 5) as never, db, MANIFEST)
    const r = await checkAndRollback(chainStub([], 5) as never, db)
    expect(r.rolledBackTo).toBeNull()
    expect(getCursor(db)).toBe(5)
    const count = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(count.n).toBe(2)
  })

  it('detects a tip reorg, rolls back, then re-indexes the new chain (replay)', async () => {
    await runOnce(chainStub([poolCreatedLog(1), swapLog(3)], 5) as never, db, MANIFEST)
    expect(getCursor(db)).toBe(5)

    // blocks 4 and 5 now have different hashes; block 3 still matches → fork point 3
    const reorged = chainStub(
      [swapLog(4, '0x000000000000000000000000000000000000dEaD')],
      5,
      new Map([
        [4, '0x' + 'dd'.repeat(32)],
        [5, '0x' + 'ee'.repeat(32)],
      ])
    )
    const result = await runOnce(reorged as never, db, MANIFEST)
    expect(result!.reorg).toBe(true)
    expect(result!.from).toBe(4) // re-indexed from the fork point
    expect(getCursor(db)).toBe(5)

    const events = db
      .prepare('SELECT args FROM events ORDER BY block_number, log_index')
      .all() as { args: string }[]
    expect(events.length).toBe(3)
    expect(JSON.parse(events[2]!.args).recipient.toLowerCase()).toBe('0x000000000000000000000000000000000000dead')
  })

  it('double-replay of the same events stores them once', async () => {
    const logs = [poolCreatedLog(2)]
    await runOnce(chainStub(logs, 4) as never, db, MANIFEST)
    // force the same range again
    db.prepare('DELETE FROM cursor').run()
    await runOnce(chainStub(logs, 4) as never, db, MANIFEST)
    const count = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('rolls back pool rows created after the fork point', async () => {
    await runOnce(chainStub([poolCreatedLog(4)], 5) as never, db, MANIFEST)
    const pools = db.prepare('SELECT COUNT(*) AS n FROM pools').get() as { n: number }
    expect(pools.n).toBe(1)

    const reorged = chainStub([], 5, new Map([[4, '0x' + 'dd'.repeat(32)], [5, '0x' + 'ee'.repeat(32)]]))
    const r = await checkAndRollback(reorged as never, db)
    expect(r.rolledBackTo).toBe(3)
    const after = db.prepare('SELECT COUNT(*) AS n FROM pools').get() as { n: number }
    expect(after.n).toBe(0)
    expect(getCursor(db)).toBe(3)
  })
})
