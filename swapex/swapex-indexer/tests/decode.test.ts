import { describe, it, expect } from 'vitest'
import { parseAbi, encodeEventTopics, encodeAbiParameters, type Abi, type AbiEvent, type Log } from 'viem'
import { ALL_EVENTS, FACTORY_EVENTS, POOL_EVENTS, POSITION_MANAGER_EVENTS } from '../src/abis'
import { decodeLogs } from '../src/decode'

const ABI = parseAbi(ALL_EVENTS as readonly string[]) as Abi
const FACTORY = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'
const POOL = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ZERO = '0x0000000000000000000000000000000000000000'

/** Pick an event by name; use firstParamType to disambiguate same-name overloads. */
function pickEvent(eventName: string, firstParamType?: string): AbiEvent {
  const candidates = ABI.filter((i): i is AbiEvent => i.type === 'event' && i.name === eventName)
  if (firstParamType) {
    const hit = candidates.find((e) => e.inputs[0]?.type === firstParamType)
    if (!hit) throw new Error(`no ${eventName} event with first param ${firstParamType}`)
    return hit
  }
  const hit = candidates[0]
  if (!hit) throw new Error(`no ${eventName} event`)
  return hit
}

function makeLog(options: {
  address: string
  event: AbiEvent
  args: Record<string, unknown>
  blockNumber: number
  logIndex: number
  txHash?: string
}): Log {
  const topics = encodeEventTopics({
    abi: [options.event],
    eventName: options.event.name,
    args: options.args as never,
  })
  const nonIndexed = options.event.inputs.filter((i) => !i.indexed)
  const data = encodeAbiParameters(
    nonIndexed.map((i) => ({ type: i.type, name: i.name })),
    nonIndexed.map((i) => options.args[i.name!] as never)
  )
  return {
    address: options.address,
    data,
    topics,
    blockNumber: BigInt(options.blockNumber),
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: options.txHash ?? ('0x' + '22'.repeat(32)),
    transactionIndex: 0,
    logIndex: options.logIndex,
    removed: false,
  } as Log
}

describe('decodeLogs', () => {
  it('decodes PoolCreated with indexed fields', () => {
    const log = makeLog({
      address: FACTORY,
      event: pickEvent('PoolCreated'),
      args: { token0: ZERO, token1: ALICE, fee: 3000, tickSpacing: 60, pool: POOL },
      blockNumber: 5,
      logIndex: 0,
    })
    const [e] = decodeLogs([log])
    expect(e).toBeDefined()
    expect(e!.event).toBe('PoolCreated')
    expect(e!.blockNumber).toBe(5)
    expect(e!.logId).toBe(`${'0x' + '22'.repeat(32)}:0`)
    const args = JSON.parse(e!.args)
    expect(args.pool.toLowerCase()).toBe(POOL.toLowerCase())
    expect(args.fee).toBe(3000) // uint24 decodes to a JS number, not bigint
  })

  it('decodes Swap and stringifies negative int256 amounts', () => {
    const log = makeLog({
      address: POOL,
      event: pickEvent('Swap'),
      args: {
        sender: ALICE,
        recipient: ALICE,
        amount0: -1000n,
        amount1: 2000n,
        sqrtPriceX96: 2n ** 96n,
        liquidity: 123n,
        tick: -60,
      },
      blockNumber: 6,
      logIndex: 3,
    })
    const [e] = decodeLogs([log])
    expect(e!.event).toBe('Swap')
    const args = JSON.parse(e!.args)
    expect(args.amount0).toBe('-1000')
    expect(args.amount1).toBe('2000')
    expect(args.tick).toBe(-60)
  })

  it('distinguishes the two Collect signatures', () => {
    const poolCollect = makeLog({
      address: POOL,
      event: pickEvent('Collect', 'address'),
      args: { owner: ALICE, recipient: ALICE, tickLower: -60, tickUpper: 60, amount0: 1n, amount1: 2n },
      blockNumber: 7,
      logIndex: 0,
      txHash: '0x' + '33'.repeat(32),
    })
    const pmCollect = makeLog({
      address: POOL,
      event: pickEvent('Collect', 'uint256'),
      args: { tokenId: 1n, recipient: ALICE, amount0: 1n, amount1: 2n },
      blockNumber: 7,
      logIndex: 1,
      txHash: '0x' + '33'.repeat(32),
    })
    const events = decodeLogs([poolCollect, pmCollect])
    expect(events.length).toBe(2)
    expect(JSON.parse(events[0]!.args).tickLower).toBe(-60)
    expect(JSON.parse(events[1]!.args).tokenId).toBe('1')
  })

  it('decodes position-manager Transfer and pool Mint', () => {
    const transfer = makeLog({
      address: POOL,
      event: pickEvent('Transfer'),
      args: { from: ZERO, to: ALICE, tokenId: 42n },
      blockNumber: 8,
      logIndex: 0,
    })
    const mint = makeLog({
      address: POOL,
      event: pickEvent('Mint'),
      args: {
        sender: ALICE,
        owner: ALICE,
        tickLower: -60,
        tickUpper: 60,
        amount: 100n,
        amount0: 1n,
        amount1: 2n,
      },
      blockNumber: 8,
      logIndex: 1,
      txHash: '0x' + '44'.repeat(32),
    })
    const events = decodeLogs([transfer, mint])
    expect(events.map((e) => e.event)).toEqual(['Transfer', 'Mint'])
    expect(JSON.parse(events[0]!.args).tokenId).toBe('42')
  })

  it('drops logs that match no known event', () => {
    const garbage = {
      address: FACTORY,
      data: '0x',
      topics: ['0x' + 'ab'.repeat(32)],
      blockNumber: 9n,
      blockHash: '0x' + '11'.repeat(32),
      transactionHash: '0x' + '22'.repeat(32),
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    } as Log
    expect(decodeLogs([garbage])).toEqual([])
  })

  it('all fragments are valid event ABIs', () => {
    expect(FACTORY_EVENTS.length + POOL_EVENTS.length + POSITION_MANAGER_EVENTS.length).toBe(ALL_EVENTS.length)
  })
})
