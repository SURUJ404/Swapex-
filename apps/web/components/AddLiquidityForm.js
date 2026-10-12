import React, { useState, useEffect, useMemo } from 'react'
import { Contract, BigNumber, utils } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI, POOL_TICK_SPACING } from '../constants'
import TokenSelectModal from './TokenSelectModal'
import NetworkGuard from './NetworkGuard'
import useTokenBalance from '../hooks/useTokenBalance'
import useAllowance from '../hooks/useAllowance'
import useApprove from '../hooks/useApprove'
import useTransact from '../hooks/useTransact'
import { buildPoolKey, isZeroForOne, getPoolState } from '../lib/pool'
import { fullRangeLiquidityForAmounts, fullRangeTicks } from '../lib/liquidity'
import { parseAmount, formatAmount } from '../lib/amounts'
import { NATIVE_ADDRESS } from '../constants'

const Q96 = BigNumber.from(2).pow(96)

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

/** The balanced counter-amount at the pool price: amount0 * (sqrtP/Q96)^2 (raw units). */
function quoteAtPrice(sqrtP, amount, fromIsCurrency0) {
  if (fromIsCurrency0) return amount.mul(sqrtP).mul(sqrtP).div(Q96).div(Q96)
  return amount.mul(Q96).mul(Q96).div(sqrtP).div(sqrtP)
}

export default function AddLiquidityForm() {
  const { account, library } = useWeb3()
  const { run, pending: adding } = useTransact()
  const { approve, approving } = useApprove()

  const [tokenA, setTokenA] = useState(TOKEN_LIST[0])
  const [tokenB, setTokenB] = useState(TOKEN_LIST[2])
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [pool, setPool] = useState(undefined) // undefined = loading, null = no pool, object = live
  const [showTokenA, setShowTokenA] = useState(false)
  const [showTokenB, setShowTokenB] = useState(false)

  const { balance: balanceA, refetch: refetchA } = useTokenBalance(tokenA)
  const { balance: balanceB, refetch: refetchB } = useTokenBalance(tokenB)
  const allowA = useAllowance(tokenA, ROUTER_ADDRESS)
  const allowB = useAllowance(tokenB, ROUTER_ADDRESS)

  const key = useMemo(() => buildPoolKey(tokenA, tokenB), [tokenA, tokenB])
  const sameToken = tokenA.address === tokenB.address
  const aIs0 = isZeroForOne(key, tokenA)

  useEffect(() => {
    if (!library || sameToken) {
      setPool(undefined)
      return
    }
    let cancelled = false
    setPool(undefined)
    getPoolState(library, key)
      .then((s) => !cancelled && setPool(s.sqrtPriceX96.isZero() ? null : s))
      .catch(() => !cancelled && setPool(undefined))
    return () => { cancelled = true }
  }, [library, key, sameToken])

  const onChangeA = (v) => {
    if (!/^\d*\.?\d*$/.test(v)) return
    setAmountA(v)
    if (pool) {
      const a = parseAmount(v, tokenA.decimals)
      setAmountB(a ? utils.formatUnits(quoteAtPrice(pool.sqrtPriceX96, a, aIs0), tokenB.decimals) : '')
    }
  }

  const onChangeB = (v) => {
    if (!/^\d*\.?\d*$/.test(v)) return
    setAmountB(v)
    if (pool) {
      const b = parseAmount(v, tokenB.decimals)
      setAmountA(b ? utils.formatUnits(quoteAtPrice(pool.sqrtPriceX96, b, !aIs0), tokenA.decimals) : '')
    }
  }

  const pickToken = (side) => (t) => {
    side === 'A' ? setTokenA(t) : setTokenB(t)
    setAmountA('')
    setAmountB('')
  }

  const bnA = useMemo(() => parseAmount(amountA, tokenA.decimals), [amountA, tokenA])
  const bnB = useMemo(() => parseAmount(amountB, tokenB.decimals), [amountB, tokenB])

  // Order the two amounts to currency0/currency1, then size a full-range liquidity delta.
  const sizing = useMemo(() => {
    if (!pool || !bnA || !bnB || bnA.isZero() || bnB.isZero()) return null
    const amount0 = aIs0 ? bnA : bnB
    const amount1 = aIs0 ? bnB : bnA
    const { liquidity, tickLower, tickUpper } = fullRangeLiquidityForAmounts(
      pool.sqrtPriceX96,
      POOL_TICK_SPACING,
      amount0,
      amount1
    )
    return liquidity.gt(0) ? { liquidity, tickLower, tickUpper } : null
  }, [pool, bnA, bnB, aIs0])

  const nativeToken = tokenA.address === NATIVE_ADDRESS ? tokenA : tokenB.address === NATIVE_ADDRESS ? tokenB : null
  const nativeAmount = nativeToken === tokenA ? bnA : nativeToken === tokenB ? bnB : null

  const needA = allowA.needsApproval(bnA)
  const needB = allowB.needsApproval(bnB)
  const insufficientA = tokenA.address !== NATIVE_ADDRESS && bnA ? bnA.gt(balanceA) : false
  const insufficientB = tokenB.address !== NATIVE_ADDRESS && bnB ? bnB.gt(balanceB) : false

  let status = null
  if (sameToken) status = 'Choose two different tokens'
  else if (pool === undefined && library) status = 'Loading pool...'
  else if (pool === null) status = 'No pool yet — create it first'
  else if (!bnA || !bnB || bnA.isZero() || bnB.isZero()) status = 'Enter amounts'
  else if (!sizing) status = 'Amounts too small'
  else if (insufficientA) status = `Insufficient ${tokenA.symbol} balance`
  else if (insufficientB) status = `Insufficient ${tokenB.symbol} balance`

  const addLiquidity = async () => {
    if (!account || !library || !sizing || !pool) return
    const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library.getSigner())
    const { tickLower, tickUpper, liquidity } = sizing
    await run({
      label: `Add ${tokenA.symbol}/${tokenB.symbol}`,
      successMessage: `Added liquidity to ${tokenA.symbol}/${tokenB.symbol}`,
      send: () =>
        router.modifyLiquidity(
          key,
          { tickLower, tickUpper, liquidityDelta: liquidity },
          account,
          nativeAmount ? { value: nativeAmount } : {}
        ),
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

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Add Liquidity</h2>
      <p className="text-xs text-[var(--text-tertiary)] -mt-4 mb-5">
        Deposits across the full price range ({fullRangeTicks(POOL_TICK_SPACING).tickLower} to {fullRangeTicks(POOL_TICK_SPACING).tickUpper}).
      </p>

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
            No pool exists for this pair yet. Create it first to set the starting price.
          </p>
        )}
        {pool && sizing && (
          <p>Liquidity: {formatAmount(sizing.liquidity, 18, 6)}</p>
        )}
      </div>

      <NetworkGuard>
        <div className="space-y-2 mt-4">
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
