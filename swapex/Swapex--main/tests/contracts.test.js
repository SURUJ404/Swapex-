import { describe, it, expect } from 'vitest'
import { encodeErrorResult, decodeErrorResult, decodeFunctionData, encodeFunctionResult, decodeFunctionResult } from 'viem'
import { dedupeAbi, abiFor, readNamed, ADDRESS_THIS } from '../lib/contracts/client'
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

describe('error encode/decode via adapter ABIs', () => {
  it('round-trips Swapex custom errors through viem', () => {
    const data = encodeErrorResult({ abi: abiFor('router'), errorName: 'TooLittleReceived' })
    expect(decodeErrorResult({ abi: abiFor('router'), data }).abiItem.name).toBe('TooLittleReceived')
  })

  it('decodes InvalidPath even though the raw ABI listed it twice', () => {
    const data = encodeErrorResult({ abi: abiFor('quoter'), errorName: 'InvalidPath' })
    expect(decodeErrorResult({ abi: abiFor('quoter'), data }).abiItem.name).toBe('InvalidPath')
  })
})

describe('router encodings', () => {
  it('round-trips exactInput through the router ABI', () => {
    const path = encodePath([A, B], [3000])
    const params = { path, recipient: OWNER, deadline: 1234567n, amountIn: 1000n, amountOutMinimum: 900n }
    const calldata = encodeExactInput(params)
    const parsed = decodeFunctionData({ abi: abiFor('router'), data: calldata })
    const p = parsed.args[0]
    expect(parsed.functionName).toBe('exactInput')
    expect(p.path).toBe(path)
    expect(p.recipient).toBe(OWNER)
    expect(p.deadline).toBe(1234567n)
    expect(p.amountIn).toBe(1000n)
    expect(p.amountOutMinimum).toBe(900n)
  })

  it('encodes unwrapWETH9 / sweepToken / refundETH', () => {
    const abi = abiFor('router')
    expect(decodeFunctionData({ abi, data: encodeUnwrapWETH9(5n, OWNER) }).functionName).toBe('unwrapWETH9')
    expect(decodeFunctionData({ abi, data: encodeSweepToken(A, 7n, OWNER) }).functionName).toBe('sweepToken')
    expect(decodeFunctionData({ abi, data: encodeRefundETH() }).functionName).toBe('refundETH')
  })

  it('composes exactInputToETH as swap-into-router then unwrap', () => {
    const [swapCall, unwrapCall] = encodeExactInputToETH(
      { path: encodePath([A, B], [500]), deadline: 1n, amountIn: 10n, amountOutMinimum: 9n },
      9n,
      OWNER
    )
    const abi = abiFor('router')
    expect(decodeFunctionData({ abi, data: swapCall }).args[0].recipient).toBe(ADDRESS_THIS)
    expect(decodeFunctionData({ abi, data: unwrapCall }).args[1]).toBe(OWNER)
  })
})

describe('positionManager encodings', () => {
  it('round-trips decreaseLiquidity and collect', () => {
    const abi = abiFor('positionManager')
    const dec = decodeFunctionData({
      abi,
      data: encodeDecreaseLiquidity({ tokenId: 1n, liquidity: 100n, amount0Min: 1n, amount1Min: 2n, deadline: 3n }),
    })
    expect(dec.functionName).toBe('decreaseLiquidity')
    expect(dec.args[0].liquidity).toBe(100n)

    const col = decodeFunctionData({
      abi,
      data: encodeCollect({ tokenId: 1n, recipient: OWNER, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }),
    })
    expect(col.functionName).toBe('collect')
    expect(col.args[0].amount0Max).toBe(MAX_UINT128)
  })

  it('round-trips mint params', () => {
    const abi = abiFor('positionManager')
    const minted = decodeFunctionData({
      abi,
      data: encodeMint({
        token0: A,
        token1: B,
        fee: 3000,
        tickLower: -60,
        tickUpper: 60,
        amount0Desired: 1000n,
        amount1Desired: 2000n,
        amount0Min: 990n,
        amount1Min: 1980n,
        recipient: OWNER,
        deadline: 99n,
      }),
    })
    expect(minted.functionName).toBe('mint')
    expect(minted.args[0].fee).toBe(3000)
    expect(minted.args[0].tickLower).toBe(-60)
  })
})

describe('decodeContractError via adapter ABIs', () => {
  it('names a Swapex custom error from revert data', () => {
    const data = encodeErrorResult({ abi: abiFor('router'), errorName: 'PartialFill' })
    expect(decodeContractError({ data })).toBe('PartialFill')
  })

  it('names position manager errors too', () => {
    const data = encodeErrorResult({ abi: abiFor('positionManager'), errorName: 'PriceSlippage' })
    expect(decodeContractError({ data })).toBe('PriceSlippage')
  })

  it('returns null for unknown revert data', () => {
    expect(decodeContractError({ data: '0xdeadbeef' })).toBe(null)
    expect(decodeContractError({})).toBe(null)
  })
})

describe('readNamed (viem multi-output reads)', () => {
  // viem's decodeFunctionResult returns a plain array for multi-output functions,
  // dropping the ABI's output names — the ethers->viem migration broke every
  // quote/slot0 read this way until readNamed re-attached them. These tests go
  // through viem's real encode/decode path so a future viem change gets caught here.
  const fakeClient = (abi, functionName, data) => ({
    readContract: async () => decodeFunctionResult({ abi, functionName, data }),
  })

  it('attaches ABI output names to a multi-output quoter result', async () => {
    const abi = abiFor('quoter')
    const data = encodeFunctionResult({
      abi,
      functionName: 'quoteExactInput',
      result: [12345n, [777n, 888n], [-60n, 10n], 21000n],
    })
    const client = fakeClient(abi, 'quoteExactInput', data)
    const r = await readNamed(client, { address: ADDRESS_THIS, abi }, 'quoteExactInput', ['0x00', 1n])
    expect(r.amountOut).toBe(12345n)
    expect(r.gasEstimate).toBe(21000n)
    expect(r.sqrtPricesAfter).toEqual([777n, 888n])
    expect(r[0]).toBe(12345n) // index access still works
  })

  it('attaches names to pool slot0 so sqrtPriceX96 survives decoding', async () => {
    const abi = abiFor('pool')
    const data = encodeFunctionResult({
      abi,
      functionName: 'slot0',
      result: [25165824n, -60, 10, true],
    })
    const client = fakeClient(abi, 'slot0', data)
    const s0 = await readNamed(client, { address: ADDRESS_THIS, abi }, 'slot0')
    expect(s0.sqrtPriceX96).toBe(25165824n)
    expect(s0.tick).toBe(-60)
    expect(s0.unlocked).toBe(true)
  })

  it('passes single-output reads through untouched', async () => {
    const abi = abiFor('erc20')
    const data = encodeFunctionResult({ abi, functionName: 'balanceOf', result: [5000n] })
    const client = fakeClient(abi, 'balanceOf', data)
    const balance = await readNamed(client, { address: ADDRESS_THIS, abi }, 'balanceOf', [ADDRESS_THIS])
    expect(balance).toBe(5000n)
  })
})
