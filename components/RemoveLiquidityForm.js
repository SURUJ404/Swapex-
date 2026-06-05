import React, { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { useToast } from './Toast'
import { ROUTER_ADDRESS, ROUTER_ABI, PAIR_ABI } from '../constants'

export default function RemoveLiquidityForm() {
  const { account, library } = useWeb3()
  const { addToast } = useToast()

  const [pairAddress, setPairAddress] = useState('')
  const [lpBalance, setLpBalance] = useState('0')
  const [removeAmount, setRemoveAmount] = useState('')
  const [token0, setToken0] = useState('')
  const [token1, setToken1] = useState('')
  const [loading, setLoading] = useState(false)

  const fetchPairInfo = useCallback(async () => {
    if (!library || !ethers.utils.isAddress(pairAddress)) return
    try {
      const pair = new ethers.Contract(pairAddress, PAIR_ABI, library)
      const [t0, t1] = await Promise.all([pair.token0(), pair.token1()])
      setToken0(t0)
      setToken1(t1)
      if (account) {
        const bal = await pair.balanceOf(account)
        const dec = await pair.decimals()
        setLpBalance(ethers.utils.formatUnits(bal, dec))
      }
    } catch {
      setToken0('')
      setToken1('')
      setLpBalance('0')
    }
  }, [pairAddress, library, account])

  useEffect(() => {
    fetchPairInfo()
  }, [fetchPairInfo])

  const removeLiquidity = async () => {
    if (!account || !library || !removeAmount || !pairAddress) return
    setLoading(true)
    try {
      const signer = library.getSigner()
      const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer)
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20

      const tx = await router.removeLiquidity(
        token0,
        token1,
        ethers.utils.parseUnits(removeAmount, 18),
        0,
        0,
        account,
        deadline
      )
      const receipt = await tx.wait()
      addToast('Liquidity removed successfully', 'success')
      const txs = JSON.parse(localStorage.getItem('swapex_transactions') || '[]')
      txs.push({ hash: receipt.transactionHash, label: 'Remove Liquidity', status: 'confirmed' })
      localStorage.setItem('swapex_transactions', JSON.stringify(txs))
      setRemoveAmount('')
      fetchPairInfo()
    } catch (e) {
      addToast(e.message || 'Remove liquidity failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Remove Liquidity</h2>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-[var(--text-tertiary)] mb-1 block">Pair Address (LP Token)</label>
          <input
            type="text"
            placeholder="0x..."
            value={pairAddress}
            onChange={(e) => setPairAddress(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
        </div>

        {token0 && token1 && (
          <div className="bg-[var(--bg-secondary)] rounded-xl p-3 text-sm">
            <p className="text-[var(--text-tertiary)]">Pair: <span className="text-[var(--text-primary)] font-mono">{token0.slice(0, 6)}... / {token1.slice(0, 6)}...</span></p>
            <p className="text-[var(--text-tertiary)] mt-1">LP Balance: <span className="text-[var(--text-primary)] font-mono">{parseFloat(lpBalance).toFixed(4)}</span></p>
          </div>
        )}

        <div>
          <label className="text-xs text-[var(--text-tertiary)] mb-1 block">Amount to Remove</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              placeholder="0.0"
              value={removeAmount}
              onChange={(e) => setRemoveAmount(e.target.value)}
              max={lpBalance}
              className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-lg font-mono outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={() => setRemoveAmount(lpBalance)}
              className="px-3 py-2 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] text-xs font-medium hover:bg-[var(--accent)]/20 transition-colors"
            >
              MAX
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={removeLiquidity}
        disabled={!account || !removeAmount || !pairAddress || loading}
        className={`w-full mt-6 py-3 rounded-xl font-semibold text-sm font-display transition-all ${
          !account
            ? 'bg-[var(--accent)] text-white'
            : loading
            ? 'bg-[var(--accent)]/50 text-white cursor-wait'
            : 'bg-[var(--danger)] text-white hover:opacity-90'
        }`}
      >
        {!account ? 'Connect Wallet' : loading ? 'Removing...' : 'Remove Liquidity'}
      </button>
    </div>
  )
}
