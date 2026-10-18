import { describe, it, expect } from 'vitest'
import { utils } from 'ethers'
import { dedupeAbi, abiFor, getInterface, ADDRESS_THIS } from '../lib/contracts/client'
import { encodeExactInput, encodeUnwrapWETH9, encodeSweepToken, encodeRefundETH, encodeExactInputToETH } from '../lib/contracts/router'
import { encodeDecreaseLiquidity, encodeCollect, encodeMint, MAX_UINT128 } from '../lib/contracts/positionManager'
import { decodeContractError } from '../lib/errors'
import { encodePath } from '../lib/path'
import routerAbiRaw from '../lib/abi/SwapexRouter.json'

const A = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const B = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('dedupeAbi', () => {
  it('removes the duplicate InvalidPath error from the exported ABIs', () => {
    const rawInvalid = routerAbiRaw.filter((f) => f.type === 'error' && f.name === 'InvalidPath')
    expect(rawInvalid.length).toBe(2)
    const deduped = abiFor('router')
    const invalidPaths = deduped.filter((f) => f.type === 'error' && f.name === 'InvalidPath')
    expect(invalidPaths.length).toBe(1)
  })

  it('keeps every distinct fragment', () => {
    const router = abiFor('router')
    const fns = router.filter((f) => f.type === 'function').map((f) => f.name)
    expect(fns).toContain('exactInput')
    expect(fns).toContain('multicall')
    expect(fns).toContain('refundETH')
  })

  it('dedupes by type + name + input types only', () => {
    const dup = [
      { type: 'error', name: 'X', inputs: [{ type: 'uint256' }] },
      { type: 'error', name: 'X', inputs: [{ type: 'uint256' }] },
      { type: 'error', name: 'X', inputs: [{ type: 'int256' }] },
    ]
    expect(dedupeAbi(dup).length).toBe(2)
  })
})

describe('getInterface', () => {
  it('builds a cached interface that parses custom errors', () => {
    const iface = getInterface('router')
    expect(getInterface('router')).toBe(iface)
    const data = iface.getSighash(iface.getError('TooLittleReceived'))
    expect(iface.parseError(data).name).toBe('TooLittleReceived')
  })

  it('decodes InvalidPath even though the raw ABI listed it twice', () => {
    const iface = getInterface('quoter')
    const data = iface.getSighash(iface.getError('InvalidPath'))
    expect(iface.parseError(data).name).toBe('InvalidPath')
  })
})

describe('router encodings', () => {
  it('round-trips exactInput through the router interface', () => {
    const path = encodePath([A, B], [3000])
    const params = { path, recipient: OWNER, deadline: 1234567, amountIn: 1000, amountOutMinimum: 900 }
    const calldata = encodeExactInput(params)
    const parsed = getInterface('router').parseTransaction({ data: calldata })
    const p = parsed.args[0]
    expect(parsed.name).toBe('exactInput')
    expect(p.path).toBe(path)
    expect(p.recipient).toBe(OWNER)
    expect(p.deadline.toString()).toBe('1234567')
    expect(p.amountIn.toString()).toBe('1000')
    expect(p.amountOutMinimum.toString()).toBe('900')
  })

  it('encodes unwrapWETH9 / sweepToken / refundETH', () => {
    const iface = getInterface('router')
    expect(iface.parseTransaction({ data: encodeUnwrapWETH9(5, OWNER) }).name).toBe('unwrapWETH9')
    expect(iface.parseTransaction({ data: encodeSweepToken(A, 7, OWNER) }).name).toBe('sweepToken')
    expect(iface.parseTransaction({ data: encodeRefundETH() }).name).toBe('refundETH')
  })

  it('composes exactInputToETH as swap-into-router then unwrap', () => {
    const [swapCall, unwrapCall] = encodeExactInputToETH(
      { path: encodePath([A, B], [500]), deadline: 1, amountIn: 10, amountOutMinimum: 9 },
      9,
      OWNER
    )
    const iface = getInterface('router')
    expect(iface.parseTransaction({ data: swapCall }).args[0].recipient).toBe(ADDRESS_THIS)
    expect(iface.parseTransaction({ data: unwrapCall }).args[1]).toBe(OWNER)
  })
})

describe('positionManager encodings', () => {
  it('round-trips decreaseLiquidity and collect', () => {
    const iface = getInterface('positionManager')
    const dec = iface.parseTransaction({
      data: encodeDecreaseLiquidity({ tokenId: 1, liquidity: 100, amount0Min: 1, amount1Min: 2, deadline: 3 }),
    })
    expect(dec.name).toBe('decreaseLiquidity')
    expect(dec.args[0].liquidity.toString()).toBe('100')

    const col = iface.parseTransaction({
      data: encodeCollect({ tokenId: 1, recipient: OWNER, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }),
    })
    expect(col.name).toBe('collect')
    expect(col.args[0].amount0Max.toString()).toBe(MAX_UINT128.toString())
  })

  it('round-trips mint params', () => {
    const iface = getInterface('positionManager')
    const minted = iface.parseTransaction({
      data: encodeMint({
        token0: A,
        token1: B,
        fee: 3000,
        tickLower: -60,
        tickUpper: 60,
        amount0Desired: 1000,
        amount1Desired: 2000,
        amount0Min: 990,
        amount1Min: 1980,
        recipient: OWNER,
        deadline: 99,
      }),
    })
    expect(minted.name).toBe('mint')
    expect(minted.args[0].fee).toBe(3000)
    expect(minted.args[0].tickLower).toBe(-60)
  })
})

describe('decodeContractError via adapter interfaces', () => {
  it('names a Swapex custom error from revert data', () => {
    const iface = getInterface('router')
    const data = iface.getSighash(iface.getError('PartialFill'))
    expect(decodeContractError({ data })).toBe('PartialFill')
  })

  it('names position manager errors too', () => {
    const iface = getInterface('positionManager')
    const data = iface.getSighash(iface.getError('PriceSlippage'))
    expect(decodeContractError({ data })).toBe('PriceSlippage')
  })

  it('returns null for unknown revert data', () => {
    expect(decodeContractError({ data: '0xdeadbeef' })).toBe(null)
    expect(decodeContractError({})).toBe(null)
  })
})

describe('ethers Interface construction', () => {
  it('no longer logs duplicate-definition warnings for the exported ABIs', () => {
    const warnings = []
    const origLog = console.log
    const origWarn = console.warn
    const capture = (...args) => warnings.push(args.join(' '))
    console.log = capture
    console.warn = capture
    try {
      for (const name of ['router', 'quoter', 'positionManager', 'factory', 'pool']) {
        new utils.Interface(abiFor(name))
      }
    } finally {
      console.log = origLog
      console.warn = origWarn
    }
    expect(warnings.filter((w) => /duplicate definition/i.test(w))).toEqual([])
  })
})
