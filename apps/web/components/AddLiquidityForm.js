import React, { useState, useEffect, useMemo } from 'react'
import { Contract } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI } from '../constants'
import TokenSelectModal from './TokenSelectModal'
import NetworkGuard from './NetworkGuard'
import SlippageSettings from './SlippageSettings'
import useTokenBalance from '../hooks/useTokenBalance'
import useAllowance from '../hooks/useAllowance'
import useApprove from '../hooks/useApprove'
import useTransact from '../hooks/useTransact'
import { getPoolReserves, toPathAddress } from '../lib/route'
import {
  parseAmount,
  minAfterSlippage,
  quote,
  deadlineFromNow,
  formatAmount,
} from '../lib/amounts'
import { DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_MINUTES } from '../lib/config'

function TokenButton({ token, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)]"
    >
      <img src={token.logo} alt={token.symbol} className="w-5 h-5 rounded-full" />
      {token.symbol}
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  )
}

export default function AddLiquidityForm() {
  const { account, library } = useWeb3()
  const { run, pending: adding } = useTransact()
  const { approve, approving } = useApprove()

  const [tokenA, setTokenA] = useState(TOKEN_LIST[0])
  const [tokenB, setTokenB] = useState(TOKEN_LIST[2])
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [deadlineMin, setDeadlineMin] = useState(DEFAULT_DEADLINE_MINUTES)
  const [pool, setPool] = useState(undefined) // undefined = loading, null = no pool
  const [showTokenA, setShowTokenA] = useState(false)
  const [showTokenB, setShowTokenB] = useState(false)

  const { balance: balanceA, refetch: refetchA } = useTokenBalance(tokenA)
  const { balance: balanceB, refetch: refetchB } = useTokenBalance(tokenB)
  const allowA = useAllowance(tokenA, ROUTER_ADDRESS)
  const allowB = useAllowance(tokenB, ROUTER_ADDRESS)

  const sameToken = toPathAddress(tokenA).toLowerCase() === toPathAddress(tokenB).toLowerCase()

  // Load pool reserves so the second amount can follow the pool ratio.
  useEffect(() => {
    if (!library || sameToken) {
      setPool(undefined)
      return
    }
    let cancelled = false
    setPool(undefined)
    getPoolReserves(library, toPathAddress(tokenA), toPathAddress(tokenB))
      .then((p) => {
        if (!cancelled) setPool(p && p.reserveA.gt(0) && p.reserveB.gt(0) ? p : null)
      })
      .catch(() => !cancelled && setPool(undefined))
    return () => { cancelled = true }
  }, [library, tokenA, tokenB, sameToken])

  const onChangeA = (v) => {
    if (!/^\d*\.?\d*$/.test(v)) return
    setAmountA(v)
    if (pool) {
      const a = parseAmount(v, tokenA.decimals)
      const b = a && quote(a, pool.reserveA, pool.reserveB)
      setAmountB(b ? formatAmount(b, tokenB.decimals, tokenB.decimals) : '')
    }
  }

  const onChangeB = (v) => {
    if (!/^\d*\.?\d*$/.test(v)) return
    setAmountB(v)
    if (pool) {
      const b = parseAmount(v, tokenB.decimals)
      const a = b && quote(b, pool.reserveB, pool.reserveA)
      setAmountA(a ? formatAmount(a, tokenA.decimals, tokenA.decimals) : '')
    }
  }

  const pickToken = (side) => (t) => {
    // changing a token invalidates both amounts (the ratio is pool-specific)
    side === 'A' ? setTokenA(t) : setTokenB(t)
    setAmountA('')
    setAmountB('')
  }

  const bnA = useMemo(() => parseAmount(amountA, tokenA.decimals), [amountA, tokenA])
  const bnB = useMemo(() => parseAmount(amountB, tokenB.decimals), [amountB, tokenB])

  const needA = allowA.needsApproval(bnA)
  const needB = allowB.needsApproval(bnB)
  const insufficientA = bnA ? bnA.gt(balanceA) : false
  const insufficientB = bnB ? bnB.gt(balanceB) : false

  let status = null
  if (sameToken) status = 'Choose two different tokens'
  else if (pool === undefined && library) status = 'Loading pool...'
  else if (!bnA || !bnB) status = 'Enter amounts'
  else if (insufficientA) status = `Insufficient ${tokenA.symbol} balance`
  else if (insufficientB) status = `Insufficient ${tokenB.symbol} balance`

  const addLiquidity = async () => {
    if (!account || !library || !bnA || !bnB) return
    const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library.getSigner())
    const deadline = deadlineFromNow(deadlineMin)
    const minA = minAfterSlippage(bnA, slippageBps)
    const minB = minAfterSlippage(bnB, slippageBps)
    await run({
      label: `Add ${tokenA.symbol}/${tokenB.symbol}`,
      successMessage: `Liquidity added: ${formatAmount(bnA, tokenA.decimals)} ${tokenA.symbol} / ${formatAmount(bnB, tokenB.decimals)} ${tokenB.symbol}`,
      send: () => {
        if (tokenA.address === 'NATIVE') {
          return router.addLiquidityETH(tokenB.address, bnB, minB, minA, account, deadline, { value: bnA })
        }
        if (tokenB.address === 'NATIVE') {
          return router.addLiquidityETH(tokenA.address, bnA, minA, minB, account, deadline, { value: bnB })
        }
        return router.addLiquidity(tokenA.address, tokenB.address, bnA, bnB, minA, minB, account, deadline)
      },
      onSuccess: () => {
        setAmountA('')
        setAmountB('')
        refetchA()
        refetchB()
        allowA.refetch()
        allowB.refetch()
      },
    })
  }

  const rate =
    pool && pool.reserveA.gt(0)
      ? formatAmount(quote(parseAmount('1', tokenA.decimals), pool.reserveA, pool.reserveB), tokenB.decimals, 6)
      : null

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Add Liquidity</h2>

      <div className="space-y-3">
        <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--text-tertiary)]">Token A</span>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">
              Balance: {formatAmount(balanceA, tokenA.decimals, 4) || '0'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={amountA}
              onChange={(e) => onChangeA(e.target.value.replace(',', '.'))}
              className="flex-1 bg-transparent text-xl font-mono text-[var(--text-primary)] outline-none"
            />
            <TokenButton token={tokenA} onClick={() => setShowTokenA(true)} />
          </div>
        </div>

        <div className="flex justify-center">
          <div className="w-8 h-8 rounded-full bg-[var(--bg-card)] border border-[var(--border)] flex items-center justify-center text-[var(--text-secondary)]">+</div>
        </div>

        <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--text-tertiary)]">Token B</span>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">
              Balance: {formatAmount(balanceB, tokenB.decimals, 4) || '0'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={amountB}
              onChange={(e) => onChangeB(e.target.value.replace(',', '.'))}
              className="flex-1 bg-transparent text-xl font-mono text-[var(--text-primary)] outline-none"
            />
            <TokenButton token={tokenB} onClick={() => setShowTokenB(true)} />
          </div>
        </div>
      </div>

      <div className="mt-4 text-xs text-[var(--text-tertiary)] font-mono">
        {pool === null && !sameToken && (
          <p className="text-yellow-500">
            No pool exists for this pair yet. You will be the first liquidity provider, and the
            ratio you enter sets the starting price.
          </p>
        )}
        {rate && (
          <p>1 {tokenA.symbol} = {rate} {tokenB.symbol}</p>
        )}
      </div>

      <SlippageSettings
        bps={slippageBps}
        onBpsChange={setSlippageBps}
        deadline={deadlineMin}
        onDeadlineChange={setDeadlineMin}
      />

      <NetworkGuard>
        <div className="space-y-2">
          {!status && needA && (
            <button
              onClick={() => approve(tokenA, ROUTER_ADDRESS, bnA, allowA.allowance, allowA.refetch)}
              disabled={approving}
              className="w-full py-3 rounded-xl font-semibold text-sm bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 transition-colors"
            >
              {approving ? 'Approving...' : `Approve ${tokenA.symbol}`}
            </button>
          )}
          {!status && needB && (
            <button
              onClick={() => approve(tokenB, ROUTER_ADDRESS, bnB, allowB.allowance, allowB.refetch)}
              disabled={approving}
              className="w-full py-3 rounded-xl font-semibold text-sm bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 transition-colors"
            >
              {approving ? 'Approving...' : `Approve ${tokenB.symbol}`}
            </button>
          )}
          <button
            onClick={addLiquidity}
            disabled={Boolean(status) || needA || needB || adding}
            className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
              status || needA || needB
                ? 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed'
                : adding
                ? 'bg-[var(--accent)]/50 text-white cursor-wait'
                : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
            }`}
          >
            {status || (needA || needB ? 'Approve tokens first' : adding ? 'Adding Liquidity...' : 'Add Liquidity')}
          </button>
        </div>
      </NetworkGuard>

      <TokenSelectModal open={showTokenA} onClose={() => setShowTokenA(false)} onSelect={pickToken('A')} />
      <TokenSelectModal open={showTokenB} onClose={() => setShowTokenB(false)} onSelect={pickToken('B')} />
    </div>
  )
}
