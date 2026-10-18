import { describe, it, expect, beforeEach } from 'vitest'
import { parseAbi, encodeEventTopics, encodeAbiParameters, type Abi, type AbiEvent, type Log } from 'viem'
import { openDb, getCursor, type Db } from '../src/db'
import { runOnce } from '../src/indexer'
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

function logAt(eventName: string, args: Record<string, unknown>, address: string, blockNumber: number, logIndex = 0): Log {
  const event = pickEvent(eventName)
  const topics = encodeEventTopics({ abi: [event], eventName, args: args as never })
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
    transactionHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    transactionIndex: 0,
    logIndex,
    removed: false,
  } as Log
}

/** Stub of the viem client: serves logs matching the address filter and block range. */
function stubClient(logs: Log[], head: number) {
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
  }
}

describe('runOnce', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('indexes from the manifest deployment block and stores the cursor', async () => {
    const created = logAt(
      'PoolCreated',
      { token0: ZERO, token1: ALICE, fee: 3000, tickSpacing: 60, pool: POOL },
      MANIFEST.factory,
      3
    )
    const client = stubClient([created], 10)
    const r = await runOnce(client as never, db, MANIFEST)
    expect(r).toEqual({ from: 0, to: 10, head: 10, events: 1 })
    expect(getCursor(db)).toBe(10)
    const pools = db.prepare('SELECT address FROM pools').all() as { address: string }[]
    expect(pools[0]!.address).toBe(POOL.toLowerCase())
  })

  it('resumes after the cursor and picks up events from newly created pools', async () => {
    const created = logAt(
      'PoolCreated',
      { token0: ZERO, token1: ALICE, fee: 500, tickSpacing: 10, pool: POOL },
      MANIFEST.factory,
      2
    )
    await runOnce(stubClient([created], 5) as never, db, MANIFEST)
    expect(getCursor(db)).toBe(5)

    const swap = logAt(
      'Swap',
      {
        sender: ALICE,
        recipient: ALICE,
        amount0: 1n,
        amount1: -1n,
        sqrtPriceX96: 2n ** 96n,
        liquidity: 1n,
        tick: 0,
      },
      POOL, // only known through the pools table
      7
    )
    const r = await runOnce(stubClient([swap], 8) as never, db, MANIFEST)
    expect(r).toEqual({ from: 6, to: 8, head: 8, events: 1 })
    const events = db.prepare('SELECT event FROM events').all() as { event: string }[]
    expect(events.map((e) => e.event).sort()).toEqual(['PoolCreated', 'Swap'])
  })

  it('returns null when caught up', async () => {
    await runOnce(stubClient([], 4) as never, db, MANIFEST)
    const r = await runOnce(stubClient([], 4) as never, db, MANIFEST)
    expect(r).toBeNull()
    expect(getCursor(db)).toBe(4)
  })

  it('a repeated pass over the same logs is a no-op (idempotent)', async () => {
    const created = logAt(
      'PoolCreated',
      { token0: ZERO, token1: ALICE, fee: 3000, tickSpacing: 60, pool: POOL },
      MANIFEST.factory,
      1
    )
    const client = stubClient([created], 3)
    await runOnce(client as never, db, MANIFEST)
    // force a re-delivery of the same range
    db.prepare('DELETE FROM cursor').run()
    const r = await runOnce(client as never, db, MANIFEST)
    expect(r!.events).toBe(1)
    const count = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(count.n).toBe(1)
  })
})
