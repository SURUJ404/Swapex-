import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { Contract } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import {
  TOKEN_LIST,
  ROUTER_ADDRESS,
  ROUTER_ABI,
  POOL_MANAGER_ADDRESS,
  POOL_MANAGER_ABI,
  POOL_TICK_SPACING,
} from '../constants'
import { buildPoolKey, toCurrencyAddress, getPoolState } from '../lib/pool'
import { fullRangeTicks } from '../lib/liquidity'
import { formatAmount } from '../lib/amounts'
import { NATIVE_ADDRESS, ZERO_ADDRESS } from '../constants'

const { tickLower, tickUpper } = fullRangeTicks(POOL_TICK_SPACING)

// V4 has no on-chain pool enumeration (no factory), so the candidate pools are every pair of the
// listed tokens; we read each one and keep those that are initialized.
function candidates() {
  const out = []
  for (let i = 0; i < TOKEN_LIST.length; i++)
    for (let j = i + 1; j < TOKEN_LIST.length; j++) out.push([TOKEN_LIST[i], TOKEN_LIST[j]])
  return out
}

function tokenFor(address) {
  if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    return TOKEN_LIST.find((t) => t.address === NATIVE_ADDRESS) || { symbol: 'ETH', decimals: 18 }
  }
  return TOKEN_LIST.find((t) => toCurrencyAddress(t).toLowerCase() === address.toLowerCase()) || {
    symbol: `${address.slice(0, 6)}…`,
    decimals: 18,
  }
}

export default function PoolOverview() {
  const { account, library, wrongNetwork } = useWeb3()
  const [pools, setPools] = useState([])
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!library || wrongNetwork) {
      setPools([])
      setLoading(false)
      return
    }
    let stale = false
    setLoading(true)
    ;(async () => {
      try {
        const pairs = candidates()
        const states = await Promise.allSettled(
          pairs.map(([ta, tb]) => getPoolState(library, buildPoolKey(ta, tb)))
        )
        const live = []
        pairs.forEach((pair, k) => {
          const r = states[k]
          if (r.status === 'fulfilled' && r.value && !r.value.sqrtPriceX96.isZero()) {
            const [ta, tb] = pair
            const key = buildPoolKey(ta, tb)
            live.push({ key, ta, tb, state: r.value })
          }
        })
        if (!stale) setPools(live)
      } catch (e) {
        console.error('Failed to fetch pools:', e)
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => { stale = true }
  }, [library, wrongNetwork])

  useEffect(() => {
    if (!account || !library || wrongNetwork || pools.length === 0) {
      setPositions([])
      return
    }
    let stale = false
    ;(async () => {
      try {
        const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library)
        const results = await Promise.allSettled(
          pools.map((p) => router.getPositionLiquidity(account, p.key, tickLower, tickUpper))
        )
        if (stale) return
        const mine = pools
          .map((p, k) => ({ ...p, liquidity: results[k].status === 'fulfilled' ? results[k].value : null }))
          .filter((p) => p.liquidity && !p.liquidity.isZero())
        setPositions(mine)
      } catch {
        if (!stale) setPositions([])
      }
    })()
    return () => { stale = true }
  }, [account, library, wrongNetwork, pools])

  const renderPool = (p, showLiquidity) => {
    const t0 = tokenFor(p.key.currency0)
    const t1 = tokenFor(p.key.currency1)
    return (
      <div key={p.key.currency0 + p.key.currency1} className="flex items-center justify-between py-2 border-b border-[var(--border)]/50 last:border-0">
        <div className="flex flex-col">
          <span className="text-sm font-mono text-[var(--text-primary)]">{t0.symbol} / {t1.symbol}</span>
          <span className="text-xs text-[var(--text-tertiary)]">
            Price: {p.state.price != null ? p.state.price.toFixed(6) : '—'}
            {showLiquidity ? ` · Liquidity: ${formatAmount(p.state.liquidity, 18, 2)}` : ''}
          </span>
        </div>
        <span className="text-xs text-[var(--text-tertiary)] font-mono">
          {showLiquidity ? `${formatAmount(p.liquidity, 18, 4)} in range` : 'live'}
        </span>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold font-display text-[var(--text-primary)]">Pool</h1>
        <div className="flex gap-2">
          <Link
            href="/add"
            className="px-4 py-2 text-sm font-medium text-white bg-[var(--accent)] rounded-xl hover:bg-[var(--accent-hover)] transition-colors"
          >
            Add Liquidity
          </Link>
          <Link
            href="/remove"
            className="px-4 py-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl hover:bg-[var(--bg-secondary)] transition-colors"
          >
            Remove
          </Link>
        </div>
      </div>

      {positions.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">Your Positions</h2>
          <div className="space-y-3">{positions.map((p) => renderPool(p, true))}</div>
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
        <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">Pools ({pools.length})</h2>
        {loading ? (
          <p className="text-sm text-[var(--text-tertiary)]">Loading pools...</p>
        ) : pools.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-[var(--text-secondary)] mb-4">No pools found</p>
            <Link
              href="/create"
              className="px-4 py-2 text-sm font-medium text-white bg-[var(--accent)] rounded-xl hover:bg-[var(--accent-hover)] transition-colors"
            >
              Create Pool
            </Link>
          </div>
        ) : (
          <div className="space-y-2">{pools.map((p) => renderPool(p, false))}</div>
        )}
      </div>
    </div>
  )
}
