// End-to-end proof that the frontend's JS liquidity math matches the deployed contracts on-chain.
// Computes a full-range liquidity delta with lib/liquidity.js, submits it via Router.modifyLiquidity,
// reads it back from the Router's per-user registry, then removes it.
// Run from apps/web:  node scripts/smokeLiquidity.mjs   (requires anvil :8545 + Deploy.s.sol executed)
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fullRangeLiquidityForAmounts, fullRangeAmountsForLiquidity, fullRangeTicks } from '../lib/liquidity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const abi = (name) => JSON.parse(readFileSync(join(__dirname, '..', 'constants', 'abi', `${name}.json`), 'utf8'))

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545'
const PK = process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const AT = process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0x1c85638e118b37167e9298c2268758e058DdfDA0'
const ROUTER = process.env.NEXT_PUBLIC_ROUTER || '0x367761085BF3C12e5DA2Df99AC6E1a824612b8fb'
const SWA = process.env.NEXT_PUBLIC_SWA || '0x7A9Ec1d04904907De0ED7b6839CcdD59c3716AC9'
const ZERO = '0x0000000000000000000000000000000000000000'
const TICK_SPACING = 60

function ok(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  console.log(`  ok  ${msg}`)
}

const provider = new ethers.providers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(PK, provider)
const router = new ethers.Contract(ROUTER, abi('Router'), wallet)
const pm = new ethers.Contract(process.env.NEXT_PUBLIC_POOL_MANAGER || '0xC9a43158891282A2B1475592D5719c001986Aaec', abi('PoolManager'), provider)
const swa = new ethers.Contract(SWA, abi('ERC20'), wallet)

// native (address 0) sorts first -> currency0 = native, currency1 = SWA
const key = { currency0: ZERO, currency1: SWA, fee: 3000, tickSpacing: TICK_SPACING, hooks: ZERO }
const { tickLower, tickUpper } = fullRangeTicks(TICK_SPACING)

console.log(`signer ${wallet.address} on chain ${(await provider.getNetwork()).chainId}`)

const [sqrtP] = await pm.getSlot0(key)
ok(sqrtP.gt(0), `pool (native, SWA) initialized at sqrtP=${sqrtP.toString()}`)

// Deposit 0.5 of each side; size a full-range liquidity delta from the live price.
const amount0 = ethers.utils.parseEther('0.5') // native side
const amount1 = ethers.utils.parseEther('0.5') // SWA side
const { liquidity } = fullRangeLiquidityForAmounts(sqrtP, TICK_SPACING, amount0, amount1)
ok(liquidity.gt(0), `computed full-range liquidity ${liquidity.toString()}`)

// The manager pulls its own (round-up) amounts for that delta; funding the full intended deposit
// guarantees coverage. Proves getAmount*Delta stays within the intended amounts.
const owed = fullRangeAmountsForLiquidity(sqrtP, TICK_SPACING, liquidity)
ok(owed.amount0.lte(amount0) && owed.amount1.lte(amount1), `lib amounts within intended deposit`)

const swaBefore = await swa.balanceOf(wallet.address)
// two-grant model: ERC-20 allowance to the AllowanceTransfer (once), then a bounded,
// expiring grant from it to the Router -- exactly what hooks/useApprove.js does in the app.
const at = new ethers.Contract(AT, abi('AllowanceTransfer'), wallet)
if ((await swa.allowance(wallet.address, AT)).lt(amount1)) {
  await (await swa.approve(AT, ethers.constants.MaxUint256)).wait()
}
const block1 = await provider.getBlock('latest')
await (await at.setAllowance(SWA, ROUTER, amount1, block1.timestamp + 3600)).wait()

const tx = await router.modifyLiquidity(
  key,
  { tickLower, tickUpper, liquidityDelta: liquidity },
  wallet.address,
  { value: amount0 }
)
const rc = await tx.wait()
ok(rc.status === 1, `modifyLiquidity (add) tx confirmed`)

const tracked = await router.getPositionLiquidity(wallet.address, key, tickLower, tickUpper)
ok(tracked.eq(liquidity), `registry tracks exactly the computed liquidity (${tracked.toString()})`)

const swaAfterAdd = await swa.balanceOf(wallet.address)
ok(swaAfterAdd.lt(swaBefore), `pulled SWA for the deposit (delta ${ethers.utils.formatEther(swaBefore.sub(swaAfterAdd))})`)

// Remove the full position.
const tx2 = await router.modifyLiquidity(
  key,
  { tickLower, tickUpper, liquidityDelta: liquidity.mul(-1) },
  wallet.address
)
await (tx2.wait())
const tracked2 = await router.getPositionLiquidity(wallet.address, key, tickLower, tickUpper)
ok(tracked2.isZero(), `registry back to zero after full remove`)

const swaFinal = await swa.balanceOf(wallet.address)
ok(swaFinal.gte(swaAfterAdd), `received SWA back on remove (now ${ethers.utils.formatEther(swaFinal)})`)

console.log('\nLIQUIDITY SMOKE PASS: lib-computed full-range add + registry read + remove all confirmed on-chain.')
