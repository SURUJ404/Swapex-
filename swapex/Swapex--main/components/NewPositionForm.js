import React, { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/router'
import { BigNumber, Contract } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import positionManagerAbi from '../lib/abi/SwapexPositionManager.json'
import factoryAbi from '../lib/abi/SwapexFactory.json'
import poolAbi from '../lib/abi/SwapexPool.json'
import { TOKENS } from '../lib/tokens'
import { DEPLOYMENT, FEE_TIERS, DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_MINUTES } from '../lib/config'
import { parseAmount, formatAmount, minAfterSlippage, deadlineFromNow } from '../lib/amounts'
import {
  tickSpacingFor, usableRange, nearestUsableTick, priceToTick, tickToPrice, formatPrice,
  priceToSqrtPriceX96, sqrtPriceX96ToTick,
} from '../lib/ticks'
import { amountsForDeposit, rangeStatus, toIntegerString } from '../lib/liquidity'
import { toPathAddress } from '../lib/swapRoute'
import useTokenBalance from '../hooks/useTokenBalance'
import useAllowance from '../hooks/useAllowance'
import useApprove from '../hooks/useApprove'
import useTransact from '../hooks/useTransact'
import TokenSelectModal from './TokenSelectModal'
import NetworkGuard from './NetworkGuard'
import SlippageSettings from './SlippageSettings'
import DataUnavailable from './DataUnavailable'

const ZERO = '0x0000000000000000000000000000000000000000'
const FEE_HINT = { 500: 'Best for stable pairs', 3000: 'Best for most pairs', 10000: 'Best for exotic pairs' }

export default function NewPositionForm() {
  if (!DEPLOYMENT) return <DataUnavailable title="New position" needs="Swapex contracts deployed on this network" />
  return <Form />
}

function numberOrNull(s) {
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

function Form() {
  const { library } = useWeb3()
  const router = useRouter()
  const { run, pending } = useTransact()
  const { approve, approving } = useApprove()

  const [tokenA, setTokenA] = useState(TOKENS[0])
  const [tokenB, setTokenB] = useState(TOKENS[2] || TOKENS[1])
  const [fee, setFee] = useState(3000)
  const [pool, setPool] = useState({ loading: true, address: null, sqrtPriceX96: null })
  const [initialPrice, setInitialPrice] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [fullRange, setFullRange] = useState(false)
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [deadlineMin, setDeadlineMin] = useState(DEFAULT_DEADLINE_MINUTES)
  const [modal, setModal] = useState(null) // 'A' | 'B' | null

  const addrA = toPathAddress(tokenA)
  const addrB = toPathAddress(tokenB)
  const sameToken = addrA.toLowerCase() === addrB.toLowerCase()
  // pools order tokens by address; "token0" has the lower address
  const aIsToken0 = addrA.toLowerCase() < addrB.toLowerCase()
  const token0 = aIsToken0 ? tokenA : tokenB
  const token1 = aIsToken0 ? tokenB : tokenA
  const spacing = tickSpacingFor(fee)

  const balA = useTokenBalance(tokenA)
  const balB = useTokenBalance(tokenB)
  const allowA = useAllowance(tokenA, DEPLOYMENT.positionManager)
  const allowB = useAllowance(tokenB, DEPLOYMENT.positionManager)

  // ---- does the pool exist, and where is its price?
  useEffect(() => {
    if (!library || sameToken) return
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (!cancelled) setPool({ loading: true, address: null, sqrtPriceX96: null })
      })
      .catch(() => {})
    ;(async () => {
      try {
        const factory = new Contract(DEPLOYMENT.factory, factoryAbi, library)
        const address = await factory.getPool(addrA, addrB, fee)
        if (address === ZERO) return !cancelled && setPool({ loading: false, address: null, sqrtPriceX96: null })
        const slot0 = await new Contract(address, poolAbi, library).slot0()
        if (!cancelled) setPool({ loading: false, address, sqrtPriceX96: slot0.sqrtPriceX96.toString() })
      } catch {
        if (!cancelled) setPool({ loading: false, address: null, sqrtPriceX96: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [library, addrA, addrB, fee, sameToken])

  // prices are shown as "B per A": flip into the pool's token1-per-token0 orientation when A is token1
  const toPoolPrice = (priceBperA) => (aIsToken0 ? priceBperA : 1 / priceBperA)
  const fromPoolPrice = (priceT1perT0) => (aIsToken0 ? priceT1perT0 : 1 / priceT1perT0)

  // ---- starting price: the pool's, or the one the user proposes for a new pool
  const poolExists = Boolean(pool.address)
  const startSqrtX96 = useMemo(() => {
    if (poolExists) return pool.sqrtPriceX96
    const p = numberOrNull(initialPrice)
    return p ? priceToSqrtPriceX96(toPoolPrice(p), token0.decimals, token1.decimals) : null
  }, [poolExists, pool.sqrtPriceX96, initialPrice, aIsToken0, token0.decimals, token1.decimals]) // eslint-disable-line react-hooks/exhaustive-deps
  const currentTick = startSqrtX96 ? sqrtPriceX96ToTick(startSqrtX96) : null
  const currentPriceBperA = currentTick != null && startSqrtX96
    ? fromPoolPrice(Math.pow(Number(startSqrtX96) / 2 ** 96, 2) * Math.pow(10, token0.decimals - token1.decimals))
    : null

  // ---- range as ticks (always lower < upper in the pool's orientation)
  const { tickLower, tickUpper, rangeError } = useMemo(() => {
    const full = usableRange(spacing)
    if (fullRange) return { tickLower: full.min, tickUpper: full.max, rangeError: null }
    const lo = numberOrNull(minPrice)
    const hi = numberOrNull(maxPrice)
    if (!lo || !hi) return { tickLower: null, tickUpper: null, rangeError: null }
    if (lo >= hi) return { tickLower: null, tickUpper: null, rangeError: 'Min price must be below max price' }
    const [pLo, pHi] = aIsToken0 ? [lo, hi] : [1 / hi, 1 / lo]
    const tl = priceToTick(pLo, token0.decimals, token1.decimals)
    const tu = priceToTick(pHi, token0.decimals, token1.decimals)
    if (tl == null || tu == null) return { tickLower: null, tickUpper: null, rangeError: 'Invalid price' }
    const l = nearestUsableTick(tl, spacing)
    const u = nearestUsableTick(tu, spacing)
    if (l >= u) return { tickLower: null, tickUpper: null, rangeError: 'Range is too narrow for this fee tier' }
    return { tickLower: l, tickUpper: u, rangeError: null }
  }, [fullRange, minPrice, maxPrice, spacing, aIsToken0, token0.decimals, token1.decimals])

  const rangeReady = tickLower != null && currentTick != null
  const status = rangeReady ? rangeStatus(currentTick, tickLower, tickUpper) : null
  // single-sided ranges accept only one token
  const needsA = status == null || status === 'both' || (aIsToken0 ? status === 'token0' : status === 'token1')
  const needsB = status == null || status === 'both' || (aIsToken0 ? status === 'token1' : status === 'token0')

  // ---- the other amount follows from the one the user typed
  const [lastEdited, setLastEdited] = useState('A')
  useEffect(() => {
    Promise.resolve()
      .then(() => {
        if (!rangeReady || !startSqrtX96) return
        const typed = lastEdited === 'A' ? tokenA : tokenB
        const raw = parseAmount(lastEdited === 'A' ? amountA : amountB, typed.decimals)
        const set = lastEdited === 'A' ? setAmountB : setAmountA
        const other = lastEdited === 'A' ? tokenB : tokenA
        if (!raw) return set('')
        const typedIsToken0 = lastEdited === 'A' ? aIsToken0 : !aIsToken0
        const r = amountsForDeposit(Number(startSqrtX96) / 2 ** 96, tickLower, tickUpper, {
          token: typedIsToken0 ? 0 : 1,
          amount: Number(raw.toString()),
        })
        if (!r) return set('')
        const otherRaw = typedIsToken0 ? r.amount1 : r.amount0
        set(otherRaw > 0 ? formatAmount(BigNumber.from(toIntegerString(otherRaw)), other.decimals, other.decimals) : '')
      })
      .catch(() => {})
  }, [lastEdited, amountA, amountB, rangeReady, startSqrtX96, tickLower, tickUpper, aIsToken0, tokenA, tokenB])

  const rawA = parseAmount(amountA, tokenA.decimals)
  const rawB = parseAmount(amountB, tokenB.decimals)
  const needA = needsA && rawA
  const needB = needsB && rawB
  const insufficientA = needA && rawA.gt(balA.balance)
  const insufficientB = needB && rawB.gt(balB.balance)
  const mustApproveA = needA && allowA.needsApproval(rawA)
  const mustApproveB = needB && allowB.needsApproval(rawB)

  const submit = async () => {
    const signer = library.getSigner()
    const pm = new Contract(DEPLOYMENT.positionManager, positionManagerAbi, signer)
    const account = await signer.getAddress()
    const [d0, d1] = aIsToken0 ? [rawA || BigNumber.from(0), rawB || BigNumber.from(0)] : [rawB || BigNumber.from(0), rawA || BigNumber.from(0)]
    const t0 = toPathAddress(token0)
    const t1 = toPathAddress(token1)
    const calls = []
    if (!poolExists) {
      calls.push(pm.interface.encodeFunctionData('createAndInitializePoolIfNecessary', [t0, t1, fee, startSqrtX96]))
    }
    calls.push(
      pm.interface.encodeFunctionData('mint', [{
        token0: t0,
        token1: t1,
        fee,
        tickLower,
        tickUpper,
        amount0Desired: d0,
        amount1Desired: d1,
        amount0Min: minAfterSlippage(d0, slippageBps),
        amount1Min: minAfterSlippage(d1, slippageBps),
        recipient: account,
        deadline: deadlineFromNow(deadlineMin),
      }])
    )
    // native ETH is wrapped by the contract from msg.value; whatever it does not use comes back
    const ethAmount = tokenA.address === 'NATIVE' ? rawA : tokenB.address === 'NATIVE' ? rawB : null
    if (ethAmount) calls.push(pm.interface.encodeFunctionData('refundETH', []))

    await run({
      label: `Add liquidity ${tokenA.symbol}/${tokenB.symbol}`,
      successMessage: 'Position created',
      send: () => pm.multicall(calls, ethAmount ? { value: ethAmount } : {}),
      onSuccess: () => router.push('/pool'),
    })
  }

  // ---- what the main button says
  let blocker = null
  if (sameToken) blocker = 'Choose two different tokens'
  else if (pool.loading) blocker = 'Loading pool…'
  else if (!poolExists && !startSqrtX96) blocker = 'Enter a starting price'
  else if (rangeError) blocker = rangeError
  else if (!rangeReady) blocker = 'Set a price range'
  else if (!needA && !needB) blocker = 'Enter an amount'
  else if (needsA && needsB && (!rawA || !rawB)) blocker = 'Enter an amount'
  else if (insufficientA) blocker = `Insufficient ${tokenA.symbol} balance`
  else if (insufficientB) blocker = `Insufficient ${tokenB.symbol} balance`

  const label = (t, a) => (
    <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-[var(--text-tertiary)]">Deposit {t.symbol}</span>
        <span className="text-xs text-[var(--text-tertiary)] font-mono">
          Balance: {formatAmount((a === 'A' ? balA : balB).balance, t.decimals, 4) || '0'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={a === 'A' ? amountA : amountB}
          disabled={a === 'A' ? !needsA : !needsB}
          onChange={(e) => {
            const v = e.target.value.replace(',', '.')
            if (!/^\d*\.?\d*$/.test(v)) return
            setLastEdited(a)
            a === 'A' ? setAmountA(v) : setAmountB(v)
          }}
          className="flex-1 bg-transparent text-xl font-mono text-[var(--text-primary)] outline-none disabled:opacity-40"
        />
        <span className="text-sm font-medium text-[var(--text-primary)]">{t.symbol}</span>
      </div>
    </div>
  )

  const tokenButton = (t, which) => (
    <button
      onClick={() => setModal(which)}
      className="flex-1 flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
    >
      <span className="flex items-center gap-2"><img src={t.logo} alt="" className="w-5 h-5 rounded-full" />{t.symbol}</span>
      <span aria-hidden>▾</span>
    </button>
  )

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">New position</h1>

      <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-2">Select pair</h2>
      <div className="flex gap-2 mb-5">{tokenButton(tokenA, 'A')}{tokenButton(tokenB, 'B')}</div>

      <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-2">Fee tier</h2>
      <div className="grid grid-cols-3 gap-2 mb-5">
        {FEE_TIERS.map((f) => (
          <button
            key={f}
            onClick={() => setFee(f)}
            className={`text-left p-3 rounded-xl border transition-colors ${fee === f ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:border-[var(--text-tertiary)]'}`}
          >
            <div className="text-sm font-semibold text-[var(--text-primary)]">{f / 10000}%</div>
            <div className="text-xs text-[var(--text-tertiary)]">{FEE_HINT[f]}</div>
          </button>
        ))}
      </div>

      {!sameToken && !pool.loading && !poolExists && (
        <div className="mb-5 rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4">
          <p className="text-sm text-yellow-500 mb-2">This pool does not exist yet. You will create it and set its starting price.</p>
          <label className="text-xs text-[var(--text-tertiary)]">Starting price ({tokenB.symbol} per {tokenA.symbol})</label>
          <input
            type="text"
            inputMode="decimal"
            value={initialPrice}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setInitialPrice(e.target.value)}
            placeholder="0.0"
            className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] font-mono text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
      )}

      {!sameToken && currentPriceBperA != null && (
        <p className="text-xs text-[var(--text-tertiary)] font-mono mb-3">
          Current price: {formatPrice(currentPriceBperA)} {tokenB.symbol} per {tokenA.symbol}
        </p>
      )}

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">Price range ({tokenB.symbol} per {tokenA.symbol})</h2>
        <button
          onClick={() => setFullRange((v) => !v)}
          className={`text-xs px-3 py-1 rounded-full border ${fullRange ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}
        >
          Full range
        </button>
      </div>
      {!fullRange && (
        <div className="grid grid-cols-2 gap-2 mb-2">
          {[['Min price', minPrice, setMinPrice], ['Max price', maxPrice, setMaxPrice]].map(([name, val, set]) => (
            <div key={name} className="bg-[var(--bg-secondary)] rounded-xl p-3">
              <label className="text-xs text-[var(--text-tertiary)]">{name}</label>
              <input
                type="text"
                inputMode="decimal"
                value={val}
                onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && set(e.target.value)}
                placeholder="0.0"
                className="w-full bg-transparent font-mono text-lg outline-none"
              />
            </div>
          ))}
        </div>
      )}
      {rangeReady && !fullRange && (
        <p className="text-xs text-[var(--text-tertiary)] font-mono mb-2">
          Rounded to usable ticks: {formatPrice(fromPoolPrice(tickToPrice(aIsToken0 ? tickLower : tickUpper, token0.decimals, token1.decimals)))} –{' '}
          {formatPrice(fromPoolPrice(tickToPrice(aIsToken0 ? tickUpper : tickLower, token0.decimals, token1.decimals)))}
        </p>
      )}
      {rangeReady && status !== 'both' && (
        <p className="text-xs text-yellow-500 mb-2">
          The price is outside this range, so only one token is needed and the position earns nothing until the price enters it.
        </p>
      )}

      <div className="space-y-2 mt-4">
        {label(tokenA, 'A')}
        {label(tokenB, 'B')}
      </div>

      <SlippageSettings bps={slippageBps} onBpsChange={setSlippageBps} deadline={deadlineMin} onDeadlineChange={setDeadlineMin} />

      <NetworkGuard>
        {blocker ? (
          <button disabled className="w-full py-3 rounded-xl font-semibold text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed">{blocker}</button>
        ) : mustApproveA ? (
          <button disabled={approving} onClick={() => approve(tokenA, DEPLOYMENT.positionManager, rawA, allowA.allowance, allowA.refetch)} className="w-full py-3 rounded-xl font-semibold text-sm bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30">
            {approving ? 'Approving…' : `Approve ${tokenA.symbol}`}
          </button>
        ) : mustApproveB ? (
          <button disabled={approving} onClick={() => approve(tokenB, DEPLOYMENT.positionManager, rawB, allowB.allowance, allowB.refetch)} className="w-full py-3 rounded-xl font-semibold text-sm bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30">
            {approving ? 'Approving…' : `Approve ${tokenB.symbol}`}
          </button>
        ) : (
          <button disabled={pending} onClick={submit} className="w-full py-3 rounded-xl font-semibold text-sm bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
            {pending ? 'Creating position…' : poolExists ? 'Add liquidity' : 'Create pool and add liquidity'}
          </button>
        )}
      </NetworkGuard>

      <TokenSelectModal open={modal === 'A'} onClose={() => setModal(null)} onSelect={(t) => { setTokenA(t); setAmountA(''); setAmountB('') }} />
      <TokenSelectModal open={modal === 'B'} onClose={() => setModal(null)} onSelect={(t) => { setTokenB(t); setAmountA(''); setAmountB('') }} />
    </div>
  )
}
