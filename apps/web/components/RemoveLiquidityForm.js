import React, { useState, useEffect, useMemo } from 'react'
import { Contract, BigNumber, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI, POOL_TICK_SPACING } from '../constants'
import TokenSelectModal from './TokenSelectModal'
import NetworkGuard from './NetworkGuard'
import useTransact from '../hooks/useTransact'
import { buildPoolKey, isZeroForOne, getPoolState } from '../lib/pool'
import { fullRangeTicks, fullRangeAmountsForLiquidity } from '../lib/liquidity'
import { formatAmount, minAfterSlippage, deadlineFromNow } from '../lib/amounts'
import { DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_MINUTES } from '../lib/config'
import { NATIVE_ADDRESS } from '../constants'

const PERCENTS = [25, 50, 75, 100]
const { tickLower, tickUpper } = fullRangeTicks(POOL_TICK_SPACING)

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

export default function RemoveLiquidityForm() {
  const { account, library } = useWeb3()
  const { run, pending: removing } = useTransact()

  const [tokenA, setTokenA] = useState(TOKEN_LIST[0])
  const [tokenB, setTokenB] = useState(TOKEN_LIST[2])
  const [percent, setPercent] = useState(0)
  const [position, setPosition] = useState(null) // { liquidity, sqrtPriceX96 }
  const [refresh, setRefresh] = useState(0)
  const [showTokenA, setShowTokenA] = useState(false)
  const [showTokenB, setShowTokenB] = useState(false)

  const key = useMemo(() => buildPoolKey(tokenA, tokenB), [tokenA, tokenB])
  const sameToken = tokenA.address === tokenB.address
  const aIs0 = isZeroForOne(key, tokenA)

  useEffect(() => {
    if (!account || !library || sameToken) {
      setPosition(null)
      return
    }
    let cancelled = false
    setPosition(null)
    ;(async () => {
      try {
        const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library)
        const [liq, state] = await Promise.all([
          router.getPositionLiquidity(account, key, tickLower, tickUpper),
          getPoolState(library, key),
        ])
        if (cancelled) return
        if (liq.isZero() || state.sqrtPriceX96.isZero()) setPosition(null)
        else setPosition({ liquidity: liq, sqrtPriceX96: state.sqrtPriceX96 })
      } catch {
        if (!cancelled) setPosition(null)
      }
    })()
    return () => { cancelled = true }
  }, [account, library, key, sameToken, refresh])

  const pickToken = (side) => (t) => {
    side === 'A' ? setTokenA(t) : setTokenB(t)
    setPercent(0)
  }

  const liquidityToRemove = useMemo(
    () => (position && percent > 0 ? position.liquidity.mul(percent).div(100) : BigNumber.from(0)),
    [position, percent]
  )

  // What comes back: split the full-range amounts at the current price, ordered to tokenA/tokenB.
  const out = useMemo(() => {
    if (!position || liquidityToRemove.isZero()) return null
    const { amount0, amount1 } = fullRangeAmountsForLiquidity(
      position.sqrtPriceX96,
      POOL_TICK_SPACING,
      liquidityToRemove
    )
    return aIs0 ? { a: amount0, b: amount1 } : { a: amount1, b: amount0 }
  }, [position, liquidityToRemove, aIs0])

  const removeLiquidity = async () => {
    if (!account || !library || !position || liquidityToRemove.isZero()) return
    const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library.getSigner())
    // B.1 bounds: receive at least the quoted amounts minus slippage (maxes unbound — receiving
    // more is fine), and never execute after the deadline the settings chose. `out` is already
    // ordered to tokenA/tokenB, so map back to currency0/currency1 via aIs0.
    const min0 = out ? minAfterSlippage(aIs0 ? out.a : out.b, DEFAULT_SLIPPAGE_BPS) : BigNumber.from(0)
    const min1 = out ? minAfterSlippage(aIs0 ? out.b : out.a, DEFAULT_SLIPPAGE_BPS) : BigNumber.from(0)
    await run({
      label: 'Remove Liquidity',
      successMessage: `Removed liquidity from ${tokenA.symbol}/${tokenB.symbol}`,
      send: () =>
        router.modifyLiquidity(
          key,
          { tickLower, tickUpper, liquidityDelta: liquidityToRemove.mul(-1) },
          account,
          { amount0Min: min0, amount1Min: min1, amount0Max: constants.MaxUint256, amount1Max: constants.MaxUint256 },
          deadlineFromNow(DEFAULT_DEADLINE_MINUTES)
        ),
      onSuccess: () => {
        setPercent(0)
        setRefresh((r) => r + 1)
      },
    })
  }

  let status = null
  if (sameToken) status = 'Choose two different tokens'
  else if (!position && library) status = 'No liquidity in this pool'
  else if (!account) status = 'Connect a wallet'
  else if (percent === 0) status = 'Choose an amount'

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Remove Liquidity</h2>

      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1 bg-[var(--bg-secondary)] rounded-xl p-4">
            <span className="text-xs text-[var(--text-tertiary)] block mb-2">Token A</span>
            <TokenButton token={tokenA} onClick={() => setShowTokenA(true)} />
          </div>
          <div className="flex-1 bg-[var(--bg-secondary)] rounded-xl p-4">
            <span className="text-xs text-[var(--text-tertiary)] block mb-2">Token B</span>
            <TokenButton token={tokenB} onClick={() => setShowTokenB(true)} />
          </div>
        </div>

        {position && (
          <div className="bg-[var(--bg-secondary)] rounded-xl p-3 text-sm">
            <p className="text-[var(--text-tertiary)]">
              Your position:{' '}
              <span className="text-[var(--text-primary)] font-mono">{formatAmount(position.liquidity, 18, 6)}</span>
            </p>
          </div>
        )}

        {position && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-[var(--text-tertiary)]">Amount to remove</label>
              <span className="text-lg font-mono text-[var(--text-primary)]">{percent}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
            <div className="flex gap-2 mt-2">
              {PERCENTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPercent(p)}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] text-xs font-medium hover:bg-[var(--accent)]/20 transition-colors"
                >
                  {p === 100 ? 'MAX' : `${p}%`}
                </button>
              ))}
            </div>
          </div>
        )}

        {out && (
          <div className="bg-[var(--bg-secondary)] rounded-xl p-3 text-sm font-mono space-y-1">
            <p className="text-xs text-[var(--text-tertiary)]">You will receive</p>
            <p className="flex justify-between text-[var(--text-primary)]">
              <span>{tokenA.symbol}</span>
              <span>{formatAmount(out.a, tokenA.decimals, 6)}</span>
            </p>
            <p className="flex justify-between text-[var(--text-primary)]">
              <span>{tokenB.symbol}</span>
              <span>{formatAmount(out.b, tokenB.decimals, 6)}</span>
            </p>
          </div>
        )}
      </div>

      <NetworkGuard>
        <button
          onClick={removeLiquidity}
          disabled={Boolean(status) || removing}
          className={`w-full mt-4 py-3 rounded-xl font-semibold text-sm font-display transition-all ${
            status
              ? 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed'
              : removing
              ? 'bg-[var(--danger)]/50 text-white cursor-wait'
              : 'bg-[var(--danger)] text-white hover:opacity-90'
          }`}
        >
          {status || (removing ? 'Removing...' : 'Remove Liquidity')}
        </button>
      </NetworkGuard>

      <TokenSelectModal open={showTokenA} onClose={() => setShowTokenA(false)} onSelect={pickToken('A')} />
      <TokenSelectModal open={showTokenB} onClose={() => setShowTokenB(false)} onSelect={pickToken('B')} />
    </div>
  )
}
