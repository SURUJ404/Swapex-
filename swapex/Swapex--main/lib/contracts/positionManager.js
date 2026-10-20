// PositionManager reads and writes (the NFT position manager owns all pool positions).
import { encodeFunctionData } from 'viem'
import { coreContract, abiFor, ADDRESS_THIS } from './client'

export { ADDRESS_THIS }
export const MAX_UINT128 = (1n << 128n) - 1n

const pm = () => coreContract('positionManager')
const encode = (functionName, args) => encodeFunctionData({ abi: abiFor('positionManager'), functionName, args })

// ---- reads (tokenId accepts a string or bigint; uint256 args must be bigints for viem)
export function ownerOf(client, tokenId) {
  return client.readContract({ ...pm(), functionName: 'ownerOf', args: [BigInt(tokenId)] })
}

export async function position(client, tokenId) {
  const p = await client.readContract({ ...pm(), functionName: 'positions', args: [BigInt(tokenId)] })
  return {
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: p.liquidity,
    tokensOwed0: p.tokensOwed0,
    tokensOwed1: p.tokensOwed1,
  }
}

export function balanceOf(client, owner) {
  return client.readContract({ ...pm(), functionName: 'balanceOf', args: [owner] })
}

export function nextTokenId(client) {
  return client.readContract({ ...pm(), functionName: 'nextTokenId' })
}

// ---- writes (return the tx hash)
export function mint(wallet, params) {
  return wallet.writeContract({ ...pm(), functionName: 'mint', args: [params] })
}

export function increaseLiquidity(wallet, params) {
  return wallet.writeContract({ ...pm(), functionName: 'increaseLiquidity', args: [params] })
}

export function decreaseLiquidity(wallet, params) {
  return wallet.writeContract({ ...pm(), functionName: 'decreaseLiquidity', args: [params] })
}

/** Collect fees (or full balances with MAX_UINT128). Returns the tx hash. */
export function collect(wallet, params) {
  return wallet.writeContract({ ...pm(), functionName: 'collect', args: [params] })
}

/** Burn an emptied position NFT. */
export function burn(wallet, tokenId) {
  return wallet.writeContract({ ...pm(), functionName: 'burn', args: [BigInt(tokenId)] })
}

export function createAndInitializePoolIfNecessary(wallet, token0, token1, fee, sqrtPriceX96, overrides) {
  return wallet.writeContract({
    ...pm(),
    functionName: 'createAndInitializePoolIfNecessary',
    args: [token0, token1, fee, sqrtPriceX96],
    value: overrides?.value,
  })
}

export function multicall(wallet, calls, overrides) {
  return wallet.writeContract({ ...pm(), functionName: 'multicall', args: [calls], value: overrides?.value })
}

// ---- encodings for multicall composition
export function encodeMint(params) {
  return encode('mint', [params])
}

export function encodeIncreaseLiquidity(params) {
  return encode('increaseLiquidity', [params])
}

export function encodeDecreaseLiquidity(params) {
  return encode('decreaseLiquidity', [params])
}

export function encodeCollect(params) {
  return encode('collect', [params])
}

export function encodeBurn(tokenId) {
  return encode('burn', [tokenId])
}

export function encodeUnwrapWETH9(amountMinimum, recipient) {
  return encode('unwrapWETH9', [amountMinimum, recipient])
}

export function encodeSweepToken(token, amountMinimum, recipient) {
  return encode('sweepToken', [token, amountMinimum, recipient])
}

export function encodeRefundETH() {
  return encode('refundETH', [])
}

export function encodeCreateAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96) {
  return encode('createAndInitializePoolIfNecessary', [token0, token1, fee, sqrtPriceX96])
}
