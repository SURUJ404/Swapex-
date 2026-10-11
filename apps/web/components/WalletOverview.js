import React, { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { TOKEN_LIST, ERC20_ABI } from '../constants'

export default function WalletOverview() {
  const { account, library, balance } = useWeb3()
  const [tokenBalances, setTokenBalances] = useState({})

  useEffect(() => {
    if (!account || !library) {
      setTokenBalances({})
      return
    }
    let stale = false
    async function fetchAll() {
      const results = {}
      const nonNative = TOKEN_LIST.filter((t) => t.address !== 'NATIVE')
      for (const token of nonNative) {
        try {
          const contract = new ethers.Contract(token.address, ERC20_ABI, library)
          const bal = await contract.balanceOf(account)
          const decimals = await contract.decimals()
          results[token.symbol] = ethers.utils.formatUnits(bal, decimals)
        } catch {
          results[token.symbol] = '0'
        }
      }
      if (!stale) setTokenBalances(results)
    }
    fetchAll()
    return () => { stale = true }
  }, [account, library])

  if (!account) return null

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
      <h2 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-4">Wallet Overview</h2>
      <div className="space-y-3">
        <div className="flex items-center justify-between py-2 border-b border-[var(--border)]/50">
          <div className="flex items-center gap-2">
            <img
              src={TOKEN_LIST[0].logo}
              alt="ETH"
              className="w-6 h-6 rounded-full"
            />
            <span className="font-medium text-[var(--text-primary)]">ETH</span>
          </div>
          <span className="font-mono text-sm text-[var(--text-secondary)]">
            {parseFloat(balance).toFixed(4)}
          </span>
        </div>
        {TOKEN_LIST.filter((t) => t.address !== 'NATIVE').map((token) => (
          <div key={token.address} className="flex items-center justify-between py-1.5">
            <div className="flex items-center gap-2">
              <img src={token.logo} alt={token.symbol} className="w-5 h-5 rounded-full" />
              <span className="text-sm text-[var(--text-secondary)]">{token.symbol}</span>
            </div>
            <span className="text-sm font-mono text-[var(--text-secondary)]">
              {parseFloat(tokenBalances[token.symbol] || '0').toFixed(4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
