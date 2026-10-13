// Standalone smoke test against a local anvil node. Proves the deployed V4 contracts, exported
// ABIs, and the exact call encoding the frontend uses: quote via Quoter (static), then a real
// swap via Router.exactInputSingle with an amountOutMin floor (native input + token->token).
// Run from apps/web:  node scripts/smoke.mjs   (requires anvil on :8545 + Deploy.s.sol executed)
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const abi = (name) => JSON.parse(readFileSync(join(__dirname, '..', 'constants', 'abi', `${name}.json`), 'utf8'))

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545'
const PK =
  process.env.PRIVATE_KEY ||
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil #0

const AT = process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0x51C65cd0Cdb1A8A8b79dfc2eE965B1bA0bb8fc89'
const ROUTER = process.env.NEXT_PUBLIC_ROUTER || '0x8fC8CFB7f7362E44E472c690A6e025B80E406458'
const QUOTER = process.env.NEXT_PUBLIC_QUOTER || '0xC7143d5bA86553C06f5730c8dC9f8187a621A8D4'
const SWA = process.env.NEXT_PUBLIC_SWA || '0xc9952Fc93Fa9bE383ccB39008c786b9f94eAc95d'
const SWB = process.env.NEXT_PUBLIC_SWB || '0xDde063eBe8E85D666AD99f731B4Dbf8C98F29708'
const ZERO = '0x0000000000000000000000000000000000000000'
const MIN_SQRT = ethers.BigNumber.from('4295128739').add(1)
const MAX_SQRT = ethers.BigNumber.from('1461446703485210103287273052203988822378723970342').sub(1)

const key = (a, b) => {
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
  return { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: ZERO }
}
const limit = (zfo) => (zfo ? MIN_SQRT : MAX_SQRT)

function ok(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  console.log(`  ok  ${msg}`)
}

const provider = new ethers.providers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(PK, provider)
const router = new ethers.Contract(ROUTER, abi('Router'), wallet)
const quoter = new ethers.Contract(QUOTER, abi('Quoter'), provider)
const swa = new ethers.Contract(SWA, abi('ERC20'), wallet)
const swb = new ethers.Contract(SWB, abi('ERC20'), provider)

console.log(`signer ${wallet.address} on ${(await provider.getNetwork()).chainId}`)

// B.1: every Router entry now takes a tx deadline (absolute unix seconds). Anchor to
// max(chain time, wall clock) + buffer: an idle local anvil only stamps blocks when it
// mines, so the latest block can lag wall by minutes and the NEXT block gets a wall-clock
// timestamp -- a chain-only deadline then expires on arrival (TransactionTooOld). Same fix
// as e2e/permit-typed-data.spec.js.
const DEADLINE = Math.max((await provider.getBlock('latest')).timestamp, Math.floor(Date.now() / 1000)) + 1200

// ---------------------------------------------------------------- native (ETH) -> SWA
{
  const k = key(ZERO, SWA)
  const zfo = k.currency0 === ZERO // native sorts first
  const amountIn = ethers.utils.parseEther('1')
  const sp = { zeroForOne: zfo, amountSpecified: amountIn, sqrtPriceLimitX96: limit(zfo) }

  const [q0, q1] = await quoter.callStatic.quoteExactInputSingle(k, sp)
  const quotedOut = zfo ? q1 : q0
  ok(quotedOut.gt(0), `quote ETH->SWA returns positive output (${ethers.utils.formatUnits(quotedOut, 18)})`)

  const before = await swa.balanceOf(wallet.address)
  const minOut = quotedOut.mul(995).div(1000) // 0.5% floor
  const tx = await router.exactInputSingle(k, sp, wallet.address, minOut, DEADLINE, { value: amountIn })
  const rc = await tx.wait()
  ok(rc.status === 1, `ETH->SWA swap tx confirmed (${rc.transactionHash.slice(0, 10)}…)`)
  const gained = (await swa.balanceOf(wallet.address)).sub(before)
  ok(gained.gte(minOut), `received ${ethers.utils.formatUnits(gained, 18)} SWA >= minOut`)
  ok(gained.lte(quotedOut), `received <= quoted (slippage respected)`)
}

// ---------------------------------------------------------------- SWA -> SWB (token -> token)
{
  const k = key(SWA, SWB)
  const zfo = k.currency0.toLowerCase() === SWA.toLowerCase()
  const amountIn = ethers.utils.parseEther('5')
  const sp = { zeroForOne: zfo, amountSpecified: amountIn, sqrtPriceLimitX96: limit(zfo) }

  const [q0, q1] = await quoter.callStatic.quoteExactInputSingle(k, sp)
  const quotedOut = zfo ? q1 : q0
  ok(quotedOut.gt(0), `quote SWA->SWB returns positive output (${ethers.utils.formatUnits(quotedOut, 18)})`)

  // two-grant model: ERC-20 allowance to the AllowanceTransfer (once), then a bounded,
  // expiring grant from it to the Router -- exactly what hooks/useApprove.js does in the app.
  const at = new ethers.Contract(AT, abi('AllowanceTransfer'), wallet)
  if ((await swa.allowance(wallet.address, AT)).lt(amountIn)) {
    await (await swa.approve(AT, ethers.constants.MaxUint256)).wait()
  }
  const block1 = await provider.getBlock('latest')
  const expiry = Math.max(block1.timestamp, Math.floor(Date.now() / 1000)) + 3600
  await (await at.setAllowance(SWA, ROUTER, amountIn, expiry)).wait()
  const before = await swb.balanceOf(wallet.address)
  const minOut = quotedOut.mul(995).div(1000)
  const tx = await router.exactInputSingle(k, sp, wallet.address, minOut, DEADLINE)
  const rc = await tx.wait()
  ok(rc.status === 1, `SWA->SWB swap tx confirmed`)
  const gained = (await swb.balanceOf(wallet.address)).sub(before)
  ok(gained.gte(minOut), `received ${ethers.utils.formatUnits(gained, 18)} SWB >= minOut`)
}

console.log('\nSMOKE PASS: quote + native swap + token swap all succeeded on-chain.')
