/**
 * Integration test: a fresh anvil node + swapex-contracts/scripts/e2e-local.sh
 * (deploy, seed three pools, two swaps) + this package's indexing pipeline and
 * HTTP API, asserting that everything the API serves equals on-chain state.
 *
 * Not part of `npm test` (it needs foundry, Git Bash and a local chain).
 * Run it with:  npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  hashTypedData,
  http,
  parseAbi,
  parseEventLogs,
  type AbiEvent,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { FACTORY_EVENTS, POOL_EVENTS, POSITION_MANAGER_EVENTS } from '../src/abis'
import { getCursor, openDb, type Db } from '../src/db'
import { loadManifest, type Manifest } from '../src/deployment'
import { runOnce } from '../src/indexer'
import { createTokenMetaProvider } from '../src/aggregate/meta'
import { buildServer } from '../src/api/server'
import { referenceStables } from '../src/aggregate/prices'
import { ORDER_TYPES, orderDomain } from '../src/eip712'
import type { FastifyInstance } from 'fastify'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..') // swapex/
const CONTRACTS = resolve(ROOT, 'swapex-contracts')
const CHAIN_ID = 31337
// anvil public development keys (same ones scripts/e2e-local.sh uses); local testing only
const MAKER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const FILLER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])
const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint8 protocolFeeDenominator, bool unlocked)',
  'function liquidity() view returns (uint128)',
])
const PM_ABI = parseAbi(['function ownerOf(uint256) view returns (address)'])
const EVENT_ABI = parseAbi([...FACTORY_EVENTS, ...POOL_EVENTS, ...POSITION_MANAGER_EVENTS])

interface DecodedLog {
  eventName?: string
  address: string
  args?: unknown
  transactionHash: string
  logIndex: number
  blockNumber: bigint
}

function argBig(args: Record<string, unknown>, key: string): bigint {
  const v = args[key]
  if (typeof v === 'bigint') return v
  if (v == null) throw new Error(`missing event arg ${key}`)
  return BigInt(String(v))
}

function argNum(args: Record<string, unknown>, key: string): number {
  return Number(argBig(args, key))
}

function lower(a: string): string {
  return a.toLowerCase()
}

function approx(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) <= 1e-9 * scale
}

/** (sqrtPriceX96)^2 / 2^192, decimal-adjusted: token1 per token0, human scale. */
function priceOf(sqrt: bigint, decimals0: number, decimals1: number): number {
  const raw = Number(sqrt) / 2 ** 96
  return raw * raw * 10 ** (decimals0 - decimals1)
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => res(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function bashPath(): string {
  if (process.platform !== 'win32') return 'bash'
  const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
  const hit = candidates.find((c) => existsSync(c))
  if (!hit) throw new Error('Git Bash not found (install Git for Windows): needed to run e2e-local.sh')
  return hit
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      done({ code: -1, out: String(e) })
      return
    }
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (e) => done({ code: -1, out: out + String(e) }))
    child.on('close', (code) => done({ code, out }))
  })
}

function killTree(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

// ---------------------------------------------------------------- chain model

interface ChainSwap {
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
  txHash: string
  blockNumber: bigint
}

interface ChainPool {
  address: string
  token0: string
  token1: string
  fee: number
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  swaps: ChainSwap[]
  mint0: bigint
  mint1: bigint
  burn0: bigint
  burn1: bigint
  collect0: bigint
  collect1: bigint
}

interface TokenInfo {
  address: string
  symbol: string
  name: string
  decimals: number
}

const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`    ok   ${name}`)
  } else {
    const line = detail ? `${name} (${detail})` : name
    failures.push(line)
    console.log(`    FAIL ${line}`)
  }
}

function finish(label: string): void {
  const held = failures.splice(0, failures.length)
  expect(held, `${label}:\n  - ${held.join('\n  - ')}`).toEqual([])
}

describe('integration: anvil + e2e-local.sh + indexer API vs chain', () => {
  let anvil: ChildProcess | null = null
  let db: Db | null = null
  let app: FastifyInstance | null = null
  let workDir = ''
  let baseUrl = ''
  let rpcUrl = ''
  let client: PublicClient
  let manifest: Manifest
  let chainPools: ChainPool[] = []
  let tokens = new Map<string, TokenInfo>()
  const ownerOfToken = new Map<string, string>() // tokenId -> current owner (chain)
  const ledgerOfToken = new Map<string, { added: bigint; removed: bigint; fee0: bigint; fee1: bigint }>()

  const api = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(baseUrl + path)
    const body = (await res.json()) as T
    return { status: res.status, body }
  }

  /** index until the cursor equals the chain head (used after keeper fills and cancels) */
  const catchUp = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      const head = Number(await client.getBlockNumber())
      await runOnce(client, db!, manifest, 12)
      if (getCursor(db!) === head) return
      await sleep(200)
    }
    throw new Error('indexer did not catch up')
  }

  const tokenInfo = async (address: string): Promise<TokenInfo> => {
    const hit = tokens.get(lower(address))
    if (hit) return hit
    const addr = address as `0x${string}`
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }),
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' }),
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }),
    ])
    const info: TokenInfo = { address: lower(address), symbol, name, decimals: Number(decimals) }
    tokens.set(info.address, info)
    return info
  }

  beforeAll(async () => {
    const foundryBin = join(homedir(), '.foundry', 'bin')
    const foundryOnDisk = existsSync(foundryBin)
    const anvilCmd = foundryOnDisk ? join(foundryBin, process.platform === 'win32' ? 'anvil.exe' : 'anvil') : 'anvil'
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: foundryOnDisk ? foundryBin + delimiter + (process.env.PATH ?? '') : process.env.PATH,
    }

    workDir = mkdtempSync(join(tmpdir(), 'swapex-int-'))
    const rpcPort = await freePort()
    rpcUrl = `http://127.0.0.1:${rpcPort}`
    client = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 })

    // 1. fresh local chain
    anvil = spawn(anvilCmd, ['--silent', '--port', String(rpcPort)], { env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let anvilOut = ''
    anvil.stdout?.on('data', (d: Buffer) => (anvilOut += d.toString()))
    anvil.stderr?.on('data', (d: Buffer) => (anvilOut += d.toString()))
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = (await client.getChainId()) === CHAIN_ID
      } catch {
        await sleep(500)
      }
    }
    if (!ready) throw new Error(`anvil did not become ready on ${rpcUrl}: ${anvilOut}`)

    // 2. deploy + seed + swap the way the web app does
    const e2e = await runProcess(bashPath(), [join(CONTRACTS, 'scripts', 'e2e-local.sh')], {
      env: { RPC: rpcUrl, PATH: spawnEnv.PATH },
      cwd: CONTRACTS,
    })
    if (e2e.code !== 0) throw new Error(`e2e-local.sh failed (exit ${e2e.code}):\n${e2e.out}`)
    console.log(`    e2e-local.sh ok (${e2e.out.trim().split('\n').length} lines of output)`)

    // 3. this package's indexing pipeline, exactly as src/index.ts wires it
    const manifestPath = join(CONTRACTS, 'deployments', `${CHAIN_ID}.json`)
    manifest = loadManifest(CHAIN_ID, { DEPLOYMENT_PATH: manifestPath })
    db = openDb(join(workDir, 'indexer.db'))
    for (let i = 0; i < 60; i++) {
      const head = Number(await client.getBlockNumber())
      await runOnce(client, db, manifest, 12)
      if (getCursor(db) === head) break
      if (i === 59) throw new Error(`indexer did not catch up (cursor ${getCursor(db)} head ${head})`)
      await sleep(200)
    }

    // 4. the HTTP API under test (client wired: POST /orders does ERC-1271 + chain-state checks)
    app = await buildServer({
      db,
      manifest,
      chainId: CHAIN_ID,
      corsOrigins: ['http://localhost:3000'],
      meta: createTokenMetaProvider(manifest, rpcUrl),
      client,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`

    // 5. the chain-side model: every decoded Swapex log in one pass
    const raw = await client.getLogs({ fromBlock: 0n, toBlock: 'latest' })
    const decoded = parseEventLogs({ abi: EVENT_ABI, logs: raw, strict: false }) as unknown as DecodedLog[]

    const poolAddrs = decoded
      .filter((l) => l.eventName === 'PoolCreated' && lower(l.address) === lower(manifest.factory))
      .map((l) => lower((l.args as Record<string, unknown>).pool as string))
    expect(poolAddrs.length, 'seed must create pools').toBeGreaterThan(0)

    for (const addr of poolAddrs) {
      const a = addr as `0x${string}`
      const [token0, token1, fee, slot0, liquidity] = await Promise.all([
        client.readContract({ address: a, abi: POOL_ABI, functionName: 'token0' }),
        client.readContract({ address: a, abi: POOL_ABI, functionName: 'token1' }),
        client.readContract({ address: a, abi: POOL_ABI, functionName: 'fee' }),
        client.readContract({ address: a, abi: POOL_ABI, functionName: 'slot0' }),
        client.readContract({ address: a, abi: POOL_ABI, functionName: 'liquidity' }),
      ])
      const pool: ChainPool = {
        address: addr,
        token0: lower(token0),
        token1: lower(token1),
        fee: Number(fee),
        sqrtPriceX96: slot0[0],
        tick: Number(slot0[1]),
        liquidity,
        swaps: [],
        mint0: 0n,
        mint1: 0n,
        burn0: 0n,
        burn1: 0n,
        collect0: 0n,
        collect1: 0n,
      }
      await tokenInfo(pool.token0)
      await tokenInfo(pool.token1)
      chainPools.push(pool)
    }

    for (const l of decoded) {
      const args = (l.args ?? {}) as Record<string, unknown>
      const addr = lower(l.address)
      const pool = chainPools.find((p) => p.address === addr)
      if (pool && l.eventName === 'Swap') {
        pool.swaps.push({
          amount0: argBig(args, 'amount0'),
          amount1: argBig(args, 'amount1'),
          sqrtPriceX96: argBig(args, 'sqrtPriceX96'),
          liquidity: argBig(args, 'liquidity'),
          tick: argNum(args, 'tick'),
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
        })
      } else if (pool && l.eventName === 'Mint') {
        pool.mint0 += argBig(args, 'amount0')
        pool.mint1 += argBig(args, 'amount1')
      } else if (pool && l.eventName === 'Burn') {
        pool.burn0 += argBig(args, 'amount0')
        pool.burn1 += argBig(args, 'amount1')
      } else if (pool && l.eventName === 'Collect') {
        pool.collect0 += argBig(args, 'amount0')
        pool.collect1 += argBig(args, 'amount1')
      } else if (addr === lower(manifest.positionManager) && l.eventName === 'Transfer') {
        const to = lower(args.to as string)
        const tokenId = argBig(args, 'tokenId').toString()
        if (to !== '0x' + '0'.repeat(40)) ownerOfToken.set(tokenId, to)
        else ownerOfToken.delete(tokenId)
      } else if (addr === lower(manifest.positionManager)) {
        const tokenId = argBig(args, 'tokenId').toString()
        let row = ledgerOfToken.get(tokenId)
        if (!row) {
          row = { added: 0n, removed: 0n, fee0: 0n, fee1: 0n }
          ledgerOfToken.set(tokenId, row)
        }
        if (l.eventName === 'IncreaseLiquidity') row.added += argBig(args, 'liquidity')
        if (l.eventName === 'DecreaseLiquidity') row.removed += argBig(args, 'liquidity')
        if (l.eventName === 'Collect') {
          row.fee0 += argBig(args, 'amount0')
          row.fee1 += argBig(args, 'amount1')
        }
      }
    }
  }, 300000)

  afterAll(async () => {
    await app?.close()
    db?.close()
    if (anvil) killTree(anvil)
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('API is healthy, on the right chain, and fully caught up with the head', async () => {
    const head = Number(await client.getBlockNumber())
    const { status, body } = await api<{ ok: boolean; chainId: number; cursor: number | null }>('/health')
    check('status 200', status === 200, `got ${status}`)
    check('ok flag', body.ok === true)
    check('chainId matches manifest', body.chainId === CHAIN_ID, `${body.chainId}`)
    check('cursor equals chain head', body.cursor === head, `cursor ${body.cursor} head ${head}`)
    finish('health')
  })

  it('/pools lists exactly the pools that exist on chain', async () => {
    const { body } = await api<{ pools: { address: string; fee: number }[]; total: number }>('/pools?limit=100')
    const apiSet = new Set(body.pools.map((p) => lower(p.address)))
    const chainSet = new Set(chainPools.map((p) => p.address))
    check('total equals on-chain pool count', body.total === chainPools.length, `api ${body.total} chain ${chainPools.length}`)
    check('pool address sets are equal', apiSet.size === chainSet.size && [...apiSet].every((a) => chainSet.has(a)))
    finish('pools list')
  })

  it('every pool matches on-chain token, fee and price state', async () => {
    const { body } = await api<{
      pools: {
        address: string
        fee: number
        token0: { address: string }
        token1: { address: string }
        sqrtPriceX96: string | null
        liquidity: string | null
        tick: number | null
        price: number | null
        change24h: number | null
      }[]
    }>('/pools?limit=100')

    for (const chain of chainPools) {
      const apiPool = body.pools.find((p) => lower(p.address) === chain.address)
      const label = `pool ${chain.address}`
      if (!apiPool) {
        check(`${label} present`, false, 'missing from /pools')
        continue
      }
      check(`${label} token0`, lower(apiPool.token0.address) === chain.token0)
      check(`${label} token1`, lower(apiPool.token1.address) === chain.token1)
      check(`${label} fee`, apiPool.fee === chain.fee, `api ${apiPool.fee} chain ${chain.fee}`)
      if (chain.swaps.length > 0) {
        const info0 = await tokenInfo(chain.token0)
        check(
          `${label} sqrtPriceX96`,
          apiPool.sqrtPriceX96 === chain.sqrtPriceX96.toString(),
          `api ${apiPool.sqrtPriceX96} chain ${chain.sqrtPriceX96}`
        )
        check(`${label} liquidity`, apiPool.liquidity === chain.liquidity.toString())
        check(`${label} tick`, apiPool.tick === chain.tick, `api ${apiPool.tick} chain ${chain.tick}`)
        const expectedPrice = priceOf(chain.sqrtPriceX96, info0.decimals, (await tokenInfo(chain.token1)).decimals)
        check(
          `${label} price`,
          apiPool.price != null && approx(apiPool.price, expectedPrice),
          `api ${apiPool.price} chain ${expectedPrice}`
        )
        check(`${label} change24h is null with no older swap`, apiPool.change24h === null, `${apiPool.change24h}`)
      } else {
        check(`${label} reports no price state before the first swap`, apiPool.sqrtPriceX96 === null)
        check(`${label} tick null before first swap`, apiPool.tick === null)
      }
    }
    finish('pool state')
  })

  it('swap history, volume and fees equal the on-chain Swap logs', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const chain of chainPools) {
      const label = `pool ${chain.address}`
      const info0 = await tokenInfo(chain.token0)
      const { body } = await api<{
        swaps: { txHash: string; amount0: number; amount1: number; sqrtPriceX96: string; tick: number }[]
      }>(`/pools/${chain.address}/swaps?limit=100`)

      const timestamps = await Promise.all(
        chain.swaps.map(async (s) => Number((await client.getBlock({ blockNumber: s.blockNumber })).timestamp))
      )
      const recent = chain.swaps.filter((_, i) => (timestamps[i] ?? 0) >= now - 86400)

      check(
        `${label} swap count`,
        body.swaps.length === chain.swaps.length,
        `api ${body.swaps.length} chain ${chain.swaps.length}`
      )

      const { body: stats } = await api<{ volume24h: number; fees24h: number; txCount24h: number; reserves0: number; reserves1: number; tvlUsd: number | null }>(
        `/pools/${chain.address}`
      )
      const volume0 = recent.reduce((acc, s) => acc + (s.amount0 < 0n ? -s.amount0 : s.amount0), 0n)
      const fees0 = recent.reduce((acc, s) => acc + ((s.amount0 < 0n ? -s.amount0 : s.amount0) * BigInt(chain.fee)) / 1_000_000n, 0n)
      const expectedVolume = Number(formatUnits(volume0, info0.decimals))
      const expectedFees = Number(formatUnits(fees0, info0.decimals))

      check(
        `${label} volume24h`,
        approx(stats.volume24h, expectedVolume),
        `api ${stats.volume24h} chain ${expectedVolume}`
      )
      check(`${label} fees24h`, approx(stats.fees24h, expectedFees), `api ${stats.fees24h} chain ${expectedFees}`)
      check(
        `${label} txCount24h`,
        stats.txCount24h === recent.length,
        `api ${stats.txCount24h} chain ${recent.length}`
      )

      // ledger: mint - burn - collect, summed straight from the chain's events
      const info1 = await tokenInfo(chain.token1)
      const reserves0 = Number(formatUnits(chain.mint0 - chain.burn0 - chain.collect0, info0.decimals))
      const reserves1 = Number(formatUnits(chain.mint1 - chain.burn1 - chain.collect1, info1.decimals))
      check(`${label} reserves0`, approx(stats.reserves0, reserves0), `api ${stats.reserves0} chain ${reserves0}`)
      check(`${label} reserves1`, approx(stats.reserves1, reserves1), `api ${stats.reserves1} chain ${reserves1}`)

      // independent check of the ledger semantics: the pool's actual token
      // balance = mints - collects + signed swap flows (burn only marks owed;
      // nothing leaves the pool until collect).
      for (const side of [0, 1] as const) {
        const token = side === 0 ? chain.token0 : chain.token1
        const balance = await client.readContract({
          address: token as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [chain.address as `0x${string}`],
        })
        const flow = chain.swaps.reduce((acc, s) => acc + (side === 0 ? s.amount0 : s.amount1), 0n)
        const minted = side === 0 ? chain.mint0 : chain.mint1
        const collected = side === 0 ? chain.collect0 : chain.collect1
        const expectedBalance = minted - collected + flow
        const drift = balance > expectedBalance ? balance - expectedBalance : expectedBalance - balance
        check(
          `${label} balance${side} == mints - collects + swap flows`,
          drift <= 2n,
          `balance ${balance} expected ${expectedBalance}`
        )
      }

      // candles: buckets must add up to the same volume
      const { body: candles } = await api<{ candles: { volume: number }[] }>(
        `/pools/${chain.address}/candles?interval=1H`
      )
      if (recent.length > 0) {
        const candleVolume = candles.candles.reduce((acc, c) => acc + c.volume, 0)
        check(`${label} candles present`, candles.candles.length > 0)
        check(
          `${label} candle volume sums to volume24h`,
          approx(candleVolume, expectedVolume),
          `candles ${candleVolume} stats ${expectedVolume}`
        )
      } else {
        check(`${label} no candles without swaps`, candles.candles.length === 0, `${candles.candles.length}`)
      }
    }
    finish('swaps/volume')
  })

  it('token metadata and USD prices follow the documented reference rule', async () => {
    const { body } = await api<{
      tokens: { address: string; symbol: string; name: string; decimals: number; usdPrice: number | null }[]
    }>('/tokens')
    const apiTokens = new Map(body.tokens.map((t) => [lower(t.address), t]))
    const stables = referenceStables(manifest)

    for (const info of tokens.values()) {
      const t = apiTokens.get(info.address)
      const label = `token ${info.symbol}`
      if (!t) {
        check(`${label} listed`, false, 'missing from /tokens')
        continue
      }
      check(`${label} symbol`, t.symbol === info.symbol, `api ${t.symbol} chain ${info.symbol}`)
      check(`${label} name`, t.name === info.name, `api ${t.name} chain ${info.name}`)
      check(`${label} decimals`, t.decimals === info.decimals, `api ${t.decimals} chain ${info.decimals}`)

      // price rule: anchors are $1, anything else is read from its newest swap
      // against an anchor pool, null when there is no such pool/swap.
      const anchor = stables.find((s) => lower(s.address) === info.address)
      if (anchor) {
        check(`${label} anchor price is 1`, t.usdPrice === 1, `${t.usdPrice}`)
        continue
      }
      let expected: number | null = null
      for (const stable of stables) {
        const pool = chainPools.find(
          (p) =>
            (p.token0 === info.address && p.token1 === lower(stable.address)) ||
            (p.token1 === info.address && p.token0 === lower(stable.address))
        )
        if (!pool || pool.swaps.length === 0) continue
        const last = pool.swaps[pool.swaps.length - 1]
        if (!last) continue
        const raw = Number(last.sqrtPriceX96) / 2 ** 96
        const rawPrice = raw * raw
        expected =
          pool.token0 === info.address
            ? rawPrice * 10 ** (info.decimals - stable.decimals)
            : (1 / rawPrice) * 10 ** (stable.decimals - info.decimals)
        break
      }
      if (expected == null) {
        check(`${label} price is honest null`, t.usdPrice === null, `${t.usdPrice}`)
      } else {
        check(
          `${label} price matches the chain`,
          t.usdPrice != null && approx(t.usdPrice, expected),
          `api ${t.usdPrice} chain ${expected}`
        )
      }
    }
    finish('tokens')
  })

  it('TVL equals the priced ledger (and stays honest where a price is missing)', async () => {
    for (const chain of chainPools) {
      const { body } = await api<{ tvlUsd: number | null; reserves0: number; reserves1: number }>(
        `/pools/${chain.address}`
      )
      const { body: tokensBody } = await api<{ tokens: { address: string; usdPrice: number | null }[] }>('/tokens')
      const price = (a: string) => tokensBody.tokens.find((t) => lower(t.address) === a)?.usdPrice ?? null
      const p0 = price(chain.token0)
      const p1 = price(chain.token1)
      const label = `pool ${chain.address}`
      if (p0 != null && p1 != null) {
        const expected = body.reserves0 * p0 + body.reserves1 * p1
        check(`${label} tvlUsd`, body.tvlUsd != null && approx(body.tvlUsd, expected), `api ${body.tvlUsd} expected ${expected}`)
      } else {
        check(`${label} tvlUsd is null without both prices`, body.tvlUsd === null, `${body.tvlUsd}`)
      }
    }
    finish('tvl')
  })

  it('positions match on-chain ownership and liquidity ledgers', async () => {
    const owners = [...new Set([...ownerOfToken.values()])]
    expect(owners.length, 'seed must mint at least one position NFT').toBeGreaterThan(0)
    let seen = 0
    for (const owner of owners) {
      const { body } = await api<{ positions: { tokenId: string; owner: string | null; liquidityAdded: string }[] }>(
        `/positions?owner=${owner}`
      )
      const chainIds = [...ownerOfToken.entries()].filter(([, o]) => o === owner).map(([id]) => id)
      const apiIds = body.positions.map((p) => p.tokenId).sort((a, b) => Number(b) - Number(a))
      check(`owner ${owner} token set`, JSON.stringify(apiIds) === JSON.stringify(chainIds.sort((a, b) => Number(b) - Number(a))), `api ${apiIds} chain ${chainIds}`)
      for (const p of body.positions) {
        const onChainOwner = await client.readContract({
          address: manifest.positionManager as `0x${string}`,
          abi: PM_ABI,
          functionName: 'ownerOf',
          args: [BigInt(p.tokenId)],
        })
        check(`token ${p.tokenId} ownerOf`, lower(onChainOwner) === owner)
        const ledger = ledgerOfToken.get(p.tokenId)
        check(
          `token ${p.tokenId} liquidityAdded`,
          p.liquidityAdded === (ledger?.added ?? 0n).toString(),
          `api ${p.liquidityAdded} chain ${ledger?.added ?? 0n}`
        )
        check(`token ${p.tokenId} has liquidity`, Number(p.liquidityAdded) > 0)
        seen++
      }
    }
    check('every chain position surfaced by the API', seen === ownerOfToken.size, `api ${seen} chain ${ownerOfToken.size}`)
    finish('positions')
  })

  it('rejects malformed input instead of guessing', async () => {
    const notAddress = await api<{ error: string }>('/pools/not-an-address')
    check('bad pool address -> 400', notAddress.status === 400, `${notAddress.status}`)
    const unknownPool = await api<{ error: string }>('/pools/0x00000000000000000000000000000000000000ff')
    check('unknown pool -> 404', unknownPool.status === 404, `${unknownPool.status}`)
    const badOwner = await api<{ error: string }>('/positions?owner=nope')
    check('bad owner -> 400', badOwner.status === 400, `${badOwner.status}`)
    const badInterval = await api<{ error: string }>(`/pools/${chainPools[0]?.address}/candles?interval=2W`)
    check('unknown candle interval -> 400', badInterval.status === 400, `${badInterval.status}`)
    const unknownToken = await api<{ error: string }>('/tokens/0x00000000000000000000000000000000000000ee')
    check('unknown token -> 404', unknownToken.status === 404, `${unknownToken.status}`)
    finish('input validation')
  })

  it('limit orders: submit, keeper fill, cancel - all equal the chain', async () => {
    const limit = manifest.limitOrders
    check('manifest has limitOrders', Boolean(limit), String(limit))
    if (!limit) {
      finish('limit orders manifest')
      return
    }
    const deployments = JSON.parse(readFileSync(join(CONTRACTS, 'deployments', `${CHAIN_ID}.json`), 'utf8')) as {
      quoter?: string
    }
    const quoter = deployments.quoter
    check('manifest has quoter', Boolean(quoter), String(quoter))

    // the seeded tUSDC/weth 3000 pool, the same one e2e-local.sh swaps through
    const usdcAddr = lower(manifest.tokens[0]!.address)
    const pool = chainPools.find((p) => p.fee === 3000 && (p.token0 === usdcAddr || p.token1 === usdcAddr))
    check('seeded tUSDC pool at fee 3000 exists', Boolean(pool))
    if (!pool || !quoter) {
      finish('limit orders setup')
      return
    }
    const wethAddr = pool.token0 === usdcAddr ? pool.token1 : pool.token0

    // realistic floor: the quoter's price minus the documented 0.1% buffer
    const QUOTER_ABI = parseAbi([
      'function quoteExactInputSingle((address,address,uint24,uint256,uint160)) returns ((uint256,uint160,int24,uint256))',
    ])
    const quoteRes = await client.call({
      to: quoter as `0x${string}`,
      data: encodeFunctionData({
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [[usdcAddr as `0x${string}`, wethAddr as `0x${string}`, 3000, 10n ** 6n, 0n]],
      }),
    })
    check('quoter returned a quote', Boolean(quoteRes.data))
    if (!quoteRes.data) {
      finish('limit orders quote')
      return
    }
    const quote = decodeFunctionResult({
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      data: quoteRes.data,
    })[0]
    const minAmountOut = quote - quote / 1000n

    const maker = privateKeyToAccount(MAKER_KEY)
    const message = {
      maker: maker.address,
      tokenIn: usdcAddr as `0x${string}`,
      tokenOut: wethAddr as `0x${string}`,
      amountIn: 10n ** 6n,
      minAmountOut,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 7n,
      receiver: maker.address,
    }
    const domain = orderDomain(CHAIN_ID, limit as `0x${string}`)
    const signature = await maker.signTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message })
    const orderHash = hashTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message })

    // viem's EIP-712 hash must equal the contract's own orderHash (otherwise every fill reverts)
    const ORDER_ABI = parseAbi([
      'function orderHash((address,address,address,uint256,uint256,uint256,uint256,address)) view returns (bytes32)',
    ])
    const chainHash = await client.readContract({
      address: limit as `0x${string}`,
      abi: ORDER_ABI,
      functionName: 'orderHash',
      args: [
        [message.maker, message.tokenIn, message.tokenOut, message.amountIn, message.minAmountOut, message.expiry, message.nonce, message.receiver],
      ],
    })
    check('viem hashTypedData == contract orderHash', chainHash === orderHash, `${chainHash} vs ${orderHash}`)

    const post = async (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(baseUrl + '/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    const payload = {
      order: {
        maker: message.maker,
        tokenIn: message.tokenIn,
        tokenOut: message.tokenOut,
        amountIn: message.amountIn.toString(),
        minAmountOut: message.minAmountOut.toString(),
        expiry: message.expiry.toString(),
        nonce: message.nonce.toString(),
        receiver: message.receiver,
      },
      signature,
      fee: 3000,
    }

    const accepted = await post(payload)
    check('POST accepts the signed order', accepted.status === 201, JSON.stringify(accepted.body))
    check('POST returns the canonical hash', accepted.body.orderHash === orderHash, String(accepted.body.orderHash))
    check('verified as eoa', accepted.body.checked === 'eoa', String(accepted.body.checked))

    const dup = await post(payload)
    check('re-submit is a duplicate, not an error', dup.status === 200, `${dup.status}`)

    const wrongSigner = privateKeyToAccount(FILLER_KEY)
    const badSig = await post({
      ...payload,
      signature: await wrongSigner.signTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message }),
    })
    check('wrong-key signature rejected', badSig.status === 400, `${badSig.status} ${JSON.stringify(badSig.body)}`)

    const openList = await api<{ orders: { orderHash: string; status: string; remaining: string; fillable: boolean }[] }>(
      '/orders?status=open'
    )
    const openOrder = openList.body.orders.find((o) => o.orderHash === orderHash)
    check('order listed as open', openOrder?.status === 'open' && openOrder?.fillable === true)
    check('remaining equals amountIn before any fill', openOrder?.remaining === '1000000', String(openOrder?.remaining))

    // --- the keeper fills it from the open list, exactly as a bot would
    const keeper = await runProcess(bashPath(), [join(CONTRACTS, 'scripts', 'keeper-limit.sh')], {
      env: {
        RPC: rpcUrl,
        INDEXER_URL: baseUrl,
        PATH: join(homedir(), '.foundry', 'bin') + delimiter + (process.env.PATH ?? ''),
      },
      cwd: CONTRACTS,
    })
    check('keeper exits 0', keeper.code === 0, `exit ${keeper.code}: ${keeper.out.trim()}`)
    check('keeper reported this fill', keeper.out.includes(`filled ${orderHash}`), keeper.out.trim())
    await catchUp()

    const filledList = await api<{
      orders: { orderHash: string; status: string; filled: string; amountOutReceived: string; remaining: string; fillable: boolean }[]
    }>('/orders?status=filled')
    const filled = filledList.body.orders.find((o) => o.orderHash === orderHash)
    check('API status is filled after the keeper', filled?.status === 'filled', String(filled?.status))
    check('API filled amount equals amountIn', filled?.filled === '1000000', String(filled?.filled))
    check('API remaining is zero', filled?.remaining === '0', String(filled?.remaining))
    check('filled order not fillable', filled?.fillable === false, String(filled?.fillable))

    // the chain agrees, number for number
    const LIMIT_ABI = parseAbi([
      'function orders(bytes32) view returns (uint256 filled, uint256 amountOutReceived)',
      'function cancel(uint256)',
    ])
    const state = await client.readContract({
      address: limit as `0x${string}`,
      abi: LIMIT_ABI,
      functionName: 'orders',
      args: [orderHash as `0x${string}`],
    })
    check('chain filled == amountIn', state[0] === 10n ** 6n, String(state[0]))
    check('chain paid something', state[1] > 0n, String(state[1]))
    check(
      'API amountOutReceived == chain',
      filled?.amountOutReceived === state[1].toString(),
      `${filled?.amountOutReceived} vs ${state[1]}`
    )
    check('maker floor held (out >= minAmountOut)', state[1] >= minAmountOut, `${state[1]} < ${minAmountOut}`)

    const refilled = await post(payload)
    check(
      're-POST of a filled order -> 409',
      refilled.status === 409,
      `${refilled.status} ${JSON.stringify(refilled.body)}`
    )

    // --- a second order, cancelled by the maker on chain
    const messageB = { ...message, nonce: 8n }
    const sigB = await maker.signTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message: messageB })
    const hashB = hashTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message: messageB })
    const postB = await post({ ...payload, order: { ...payload.order, nonce: '8' }, signature: sigB })
    check('second order accepted', postB.status === 201, JSON.stringify(postB.body))

    const wallet = createWalletClient({ account: maker, transport: http(rpcUrl) })
    const cancelTx = await wallet.sendTransaction({
      account: maker,
      chain: null,
      to: limit as `0x${string}`,
      data: encodeFunctionData({ abi: LIMIT_ABI, functionName: 'cancel', args: [messageB.nonce] }),
    })
    await client.waitForTransactionReceipt({ hash: cancelTx })
    await catchUp()

    const cancelledList = await api<{ orders: { orderHash: string; status: string; fillable: boolean }[] }>(
      '/orders?status=cancelled'
    )
    const cancelled = cancelledList.body.orders.find((o) => o.orderHash === hashB)
    check('cancel event marks the order cancelled', cancelled?.status === 'cancelled', String(cancelled?.status))
    check('cancelled order not fillable', cancelled?.fillable === false, String(cancelled?.fillable))

    const openAfter = await api<{ total: number }>('/orders?status=open')
    check('no open orders remain', openAfter.body.total === 0, String(openAfter.body.total))

    const all = await api<{ orders: { orderHash: string; status: string }[]; total: number }>('/orders?limit=100')
    check('both submitted orders listed', all.body.total === 2, String(all.body.total))
    const statuses = new Map(all.body.orders.map((o) => [o.orderHash, o.status]))
    check('first order reads filled from events', statuses.get(orderHash) === 'filled', String(statuses.get(orderHash)))
    check(
      'second order reads cancelled from events',
      statuses.get(hashB) === 'cancelled',
      String(statuses.get(hashB))
    )

    finish('limit orders')
  }, 300000)
})
