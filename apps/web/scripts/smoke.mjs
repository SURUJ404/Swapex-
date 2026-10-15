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

const AT = process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9'
const ROUTER = process.env.NEXT_PUBLIC_ROUTER || '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9'
const QUOTER = process.env.NEXT_PUBLIC_QUOTER || '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const SWA = process.env.NEXT_PUBLIC_SWA || '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853'
const SWB = process.env.NEXT_PUBLIC_SWB || '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6'
const DIST = process.env.NEXT_PUBLIC_MERKLE_DISTRIBUTOR || '0x67d269191c92Caf3cD7723F116c85e6E9bf55933'
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

// ------------------------------------------------ C: Merkle allowlist claim (D35) + duplicate fail
{
  const dist = new ethers.Contract(DIST, abi('MerkleDistributor'), wallet)
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures', 'merkle.json'), 'utf8')
  )
  ok(
    (await dist.merkleRoot()).toLowerCase() === fixture.root.toLowerCase(),
    `distributor root == committed fixture root (${fixture.root.slice(0, 12)}…)`
  )
  const c = fixture.claims[0] // index 0 = this signer (anvil #0), 1 SWA
  ok(c.account.toLowerCase() === wallet.address.toLowerCase(), `fixture claim ${c.index} is for the deployer`)
  ok(!(await dist.isClaimed(c.index)), `claim slot ${c.index} is unclaimed`)
  const before = await swa.balanceOf(wallet.address)
  await (await dist.claim(c.index, c.account, c.amount, c.proof)).wait()
  const gained = (await swa.balanceOf(wallet.address)).sub(before)
  ok(gained.eq(ethers.BigNumber.from(c.amount)), `claimed ${ethers.utils.formatEther(c.amount)} SWA for leaf account`)
  ok(await dist.isClaimed(c.index), `claim slot ${c.index} marked claimed`)
  const sel = ethers.utils.id('AlreadyClaimed(uint256)').slice(0, 10)
  let dup = false
  try {
    await dist.callStatic.claim(c.index, c.account, c.amount, c.proof)
  } catch (e) {
    const data = (e.data || (e.error && e.error.data) || '').toLowerCase()
    dup = data.startsWith(sel) || /revert/i.test(String(e.message))
  }
  ok(dup, `duplicate claim reverts AlreadyClaimed`)
}

console.log('\nSMOKE PASS: quote + swaps + merkle claim (incl. duplicate rejection) all succeeded on-chain.')
