import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { Contract, constants } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { FACTORY_ADDRESS, FACTORY_ABI, PAIR_ABI, TOKEN_LIST } from '../constants'
import { toPathAddress } from '../lib/route'
import { formatAmount } from '../lib/amounts'

const RECENT_POOLS = 25 // mainnet has ~300k pairs; never walk them all from the browser

function meta(address) {
  const t = TOKEN_LIST.find((x) => x.address.toLowerCase() === address.toLowerCase() || toPathAddress(x).toLowerCase() === address.toLowerCase())
  return { symbol: t?.symbol === 'ETH' ? 'WETH' : t?.symbol || `${address.slice(0, 6)}…`, decimals: t?.decimals ?? 18 }
}

async function readPair(library, pairAddr) {
  const pair = new Contract(pairAddr, PAIR_ABI, library)
  const [t0, t1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()])
  return { address: pairAddr, token0: t0, token1: t1, reserves }
}

export default function PoolOverview() {
  const { account, library, wrongNetwork } = useWeb3()
  const [pools, setPools] = useState([])
  const [totalPairs, setTotalPairs] = useState(0)
  const [userPositions, setUserPositions] = useState([])
  const [loading, setLoading] = useState(true)

  // Newest pools, fetched in parallel.
  useEffect(() => {
    if (!library || wrongNetwork) return
    let stale = false
    async function fetchPools() {
      try {
        const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, library)
        const count = (await factory.allPairsLength()).toNumber()
        const from = Math.max(0, count - RECENT_POOLS)
        const addrs = await Promise.all(
          Array.from({ length: count - from }, (_, k) => factory.allPairs(count - 1 - k))
        )
        const results = await Promise.allSettled(addrs.map((a) => readPair(library, a)))
        if (!stale) {
          setTotalPairs(count)
          setPools(results.filter((r) => r.status === 'fulfilled').map((r) => r.value))
        }
      } catch (e) {
        console.error('Failed to fetch pools:', e)
      } finally {
        if (!stale) setLoading(false)
      }
    }
    fetchPools()
    return () => { stale = true }
  }, [library, wrongNetwork])

  // Your positions: look up pairs between the listed tokens (no full-chain scan).
  useEffect(() => {
    if (!account || !library || wrongNetwork) {
      setUserPositions([])
      return
    }
    let stale = false
    async function fetchPositions() {
      const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, library)
      const addrs = [...new Set(TOKEN_LIST.map((t) => toPathAddress(t).toLowerCase()))]
      const combos = []
      for (let i = 0; i < addrs.length; i++) for (let j = i + 1; j < addrs.length; j++) combos.push([addrs[i], addrs[j]])
      const found = await Promise.allSettled(
        combos.map(async ([a, b]) => {
          const pairAddr = await factory.getPair(a, b)
          if (pairAddr === constants.AddressZero) return null
          const pair = new Contract(pairAddr, PAIR_ABI, library)
          const bal = await pair.balanceOf(account)
          if (bal.isZero()) return null
          const [info, totalSupply] = await Promise.all([readPair(library, pairAddr), pair.totalSupply()])
          return { ...info, bal, totalSupply }
        })
      )
      const positions = found
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map(({ value: v }) => ({
          address: v.address,
          token0: v.token0,
          token1: v.token1,
          lpBalance: v.bal,
          amount0: v.reserves._reserve0.mul(v.bal).div(v.totalSupply),
          amount1: v.reserves._reserve1.mul(v.bal).div(v.totalSupply),
        }))
      if (!stale) setUserPositions(positions)
    }
    fetchPositions().catch(() => !stale && setUserPositions([]))
    return () => { stale = true }
  }, [account, library, wrongNetwork])

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

      {userPositions.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">Your Positions</h2>
          <div className="space-y-3">
            {userPositions.map((pos) => (
              <div key={pos.address} className="bg-[var(--bg-secondary)] rounded-xl p-4">
                <p className="text-sm font-mono text-[var(--text-secondary)] mb-1">
                  {meta(pos.token0).symbol} / {meta(pos.token1).symbol}
                </p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  LP: {formatAmount(pos.lpBalance, 18, 6)} | {formatAmount(pos.amount0, meta(pos.token0).decimals, 4)} {meta(pos.token0).symbol} / {formatAmount(pos.amount1, meta(pos.token1).decimals, 4)} {meta(pos.token1).symbol}
                </p>
                <p className="text-xs text-[var(--text-tertiary)] font-mono mt-1 break-all">Pair: {pos.address}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
        <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">
          Newest Pools ({pools.length} of {totalPairs.toLocaleString()})
        </h2>
        {loading ? (
          <p className="text-sm text-[var(--text-tertiary)]">Loading pools...</p>
        ) : pools.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-[var(--text-secondary)] mb-4">No pools found</p>
            <Link
              href="/create"
              className="px-4 py-2 text-sm font-medium text-white bg-[var(--accent)] rounded-xl hover:bg-[var(--accent-hover)] transition-colors"
            >
              Create Exchange
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {pools.map((pool) => (
              <div key={pool.address} className="flex items-center justify-between py-2 border-b border-[var(--border)]/50 last:border-0">
                <div className="flex flex-col">
                  <span className="text-sm font-mono text-[var(--text-primary)]">
                    {meta(pool.token0).symbol} / {meta(pool.token1).symbol}
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    Reserve: {formatAmount(pool.reserves._reserve0, meta(pool.token0).decimals, 2)} / {formatAmount(pool.reserves._reserve1, meta(pool.token1).decimals, 2)}
                  </span>
                </div>
                <span className="text-xs text-[var(--text-tertiary)] font-mono">{pool.address.slice(0, 10)}...</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
