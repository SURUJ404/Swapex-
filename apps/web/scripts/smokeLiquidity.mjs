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
const AT = process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9'
const ROUTER = process.env.NEXT_PUBLIC_ROUTER || '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9'
const SWA = process.env.NEXT_PUBLIC_SWA || '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853'
const ZERO = '0x0000000000000000000000000000000000000000'
const TICK_SPACING = 60

function ok(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  console.log(`  ok  ${msg}`)
}

const provider = new ethers.providers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(PK, provider)
const router = new ethers.Contract(ROUTER, abi('Router'), wallet)
const pm = new ethers.Contract(process.env.NEXT_PUBLIC_POOL_MANAGER || '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', abi('PoolManager'), provider)
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
// B.1: tx deadline for every Router entry. max(chain time, wall clock) + 20 minutes: an idle
// anvil lags wall time and stamps the next block at wall time, so a chain-only deadline can
// be expired on arrival (TransactionTooOld) -- same fix as e2e/permit-typed-data.spec.js.
const DEADLINE = Math.max((await provider.getBlock('latest')).timestamp, Math.floor(Date.now() / 1000)) + 1200
// two-grant model: ERC-20 allowance to the AllowanceTransfer (once), then a bounded,
// expiring grant from it to the Router -- exactly what hooks/useApprove.js does in the app.
const at = new ethers.Contract(AT, abi('AllowanceTransfer'), wallet)
if ((await swa.allowance(wallet.address, AT)).lt(amount1)) {
  await (await swa.approve(AT, ethers.constants.MaxUint256)).wait()
}
const block1 = await provider.getBlock('latest')
const expiry = Math.max(block1.timestamp, Math.floor(Date.now() / 1000)) + 3600
await (await at.setAllowance(SWA, ROUTER, amount1, expiry)).wait()

const tx = await router.modifyLiquidity(
  key,
  { tickLower, tickUpper, liquidityDelta: liquidity },
  wallet.address,
  // B.1 bounds: pay at most the intended deposit on both sides (mins unbound).
  { amount0Min: 0, amount1Min: 0, amount0Max: amount0, amount1Max: amount1 },
  DEADLINE,
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
  wallet.address,
  // B.1 bounds: receive at least 99.5% of the amounts this deposit just paid (price is
  // unchanged within the smoke run, so the floor is comfortably met; maxes unbound).
  { amount0Min: owed.amount0.mul(995).div(1000), amount1Min: owed.amount1.mul(995).div(1000), amount0Max: ethers.constants.MaxUint256, amount1Max: ethers.constants.MaxUint256 },
  DEADLINE
)
await (tx2.wait())
const tracked2 = await router.getPositionLiquidity(wallet.address, key, tickLower, tickUpper)
ok(tracked2.isZero(), `registry back to zero after full remove`)

const swaFinal = await swa.balanceOf(wallet.address)
ok(swaFinal.gte(swaAfterAdd), `received SWA back on remove (now ${ethers.utils.formatEther(swaFinal)})`)

console.log('\nLIQUIDITY SMOKE PASS: lib-computed full-range add + registry read + remove all confirmed on-chain.')
