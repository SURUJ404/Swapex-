import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { FACTORY_ADDRESS, FACTORY_ABI, PAIR_ABI } from '../constants'

export default function PoolOverview() {
  const { account, library } = useWeb3()
  const [pools, setPools] = useState([])
  const [userPositions, setUserPositions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!library) return
    let stale = false
    async function fetchPools() {
      try {
        const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, library)
        const count = await factory.allPairsLength()
        const poolData = []
        for (let i = 0; i < count.toNumber(); i++) {
          const pairAddr = await factory.allPairs(i)
          const pair = new ethers.Contract(pairAddr, PAIR_ABI, library)
          const [t0, t1, reserves] = await Promise.all([
            pair.token0(),
            pair.token1(),
            pair.getReserves(),
          ])
          poolData.push({ address: pairAddr, token0: t0, token1: t1, reserves })
        }
        if (!stale) setPools(poolData)
      } catch (e) {
        console.error('Failed to fetch pools:', e)
      } finally {
        if (!stale) setLoading(false)
      }
    }
    fetchPools()
    return () => { stale = true }
  }, [library])

  useEffect(() => {
    if (!account || !library) return
    let stale = false
    async function fetchPositions() {
      const positions = []
      for (const pool of pools) {
        try {
          const pair = new ethers.Contract(pool.address, PAIR_ABI, library)
          const bal = await pair.balanceOf(account)
          if (!bal.isZero()) {
            const totalSupply = await pair.totalSupply()
            const token0Bal = pool.reserves._reserve0.mul(bal).div(totalSupply)
            const token1Bal = pool.reserves._reserve1.mul(bal).div(totalSupply)
            positions.push({
              address: pool.address,
              token0: pool.token0,
              token1: pool.token1,
              lpBalance: ethers.utils.formatEther(bal),
              token0Amount: ethers.utils.formatEther(token0Bal),
              token1Amount: ethers.utils.formatEther(token1Bal),
            })
          }
        } catch {
          continue
        }
      }
      if (!stale) setUserPositions(positions)
    }
    if (pools.length > 0) fetchPositions()
    return () => { stale = true }
  }, [account, library, pools])

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
            {userPositions.map((pos, i) => (
              <div key={i} className="bg-[var(--bg-secondary)] rounded-xl p-4">
                <p className="text-sm font-mono text-[var(--text-secondary)] mb-1">
                  {pos.token0.slice(0, 6)}... {pos.token1.slice(0, 6)}...
                </p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  LP: {parseFloat(pos.lpBalance).toFixed(4)} | {parseFloat(pos.token0Amount).toFixed(4)} / {parseFloat(pos.token1Amount).toFixed(4)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
        <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">
          All Pools ({pools.length})
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
            {pools.map((pool, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-[var(--border)]/50 last:border-0">
                <div className="flex flex-col">
                  <span className="text-sm font-mono text-[var(--text-primary)]">
                    {pool.token0.slice(0, 6)}... / {pool.token1.slice(0, 6)}...
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    Reserve: {ethers.utils.formatEther(pool.reserves._reserve0).slice(0, 6)} / {ethers.utils.formatEther(pool.reserves._reserve1).slice(0, 6)}
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
