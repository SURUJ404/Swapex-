import React, { useState } from 'react'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { useToast } from './Toast'
import { FACTORY_ADDRESS, FACTORY_ABI } from '../constants'

export default function CreateExchangeForm() {
  const { account, library } = useWeb3()
  const { addToast } = useToast()

  const [tokenAddress, setTokenAddress] = useState('')
  const [loading, setLoading] = useState(false)

  const createExchange = async () => {
    if (!account || !library || !tokenAddress) return
    if (!ethers.utils.isAddress(tokenAddress)) {
      addToast('Invalid token address', 'error')
      return
    }
    setLoading(true)
    try {
      const signer = library.getSigner()
      const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, signer)
      const tx = await factory.createPair(tokenAddress, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
      const receipt = await tx.wait()
      addToast('Exchange created successfully', 'success')
      const txs = JSON.parse(localStorage.getItem('swapex_transactions') || '[]')
      txs.push({ hash: receipt.transactionHash, label: 'Create Exchange', status: 'confirmed' })
      localStorage.setItem('swapex_transactions', JSON.stringify(txs))
      setTokenAddress('')
    } catch (e) {
      addToast(e.message || 'Create exchange failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Create Exchange</h2>

      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Create a new liquidity pool for a token paired with WETH.
      </p>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-[var(--text-tertiary)] mb-1 block">Token Address</label>
          <input
            type="text"
            placeholder="0x..."
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      <button
        onClick={createExchange}
        disabled={!account || !tokenAddress || loading}
        className={`w-full mt-6 py-3 rounded-xl font-semibold text-sm font-display transition-all ${
          !account
            ? 'bg-[var(--accent)] text-white'
            : loading
            ? 'bg-[var(--accent)]/50 text-white cursor-wait'
            : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
        }`}
      >
        {!account ? 'Connect Wallet' : loading ? 'Creating...' : 'Create Exchange'}
      </button>
    </div>
  )
}
