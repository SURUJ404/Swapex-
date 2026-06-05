import React, { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { useToast } from './Toast'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI, ERC20_ABI, FACTORY_ADDRESS } from '../constants'
import TokenSelectModal from './TokenSelectModal'

export default function AddLiquidityForm() {
  const { account, library } = useWeb3()
  const { addToast } = useToast()

  const [tokenA, setTokenA] = useState(TOKEN_LIST[0])
  const [tokenB, setTokenB] = useState(TOKEN_LIST[2])
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [balanceA, setBalanceA] = useState('0')
  const [balanceB, setBalanceB] = useState('0')
  const [allowance, setAllowance] = useState('0')
  const [loading, setLoading] = useState(false)
  const [approving, setApproving] = useState(false)
  const [showTokenA, setShowTokenA] = useState(false)
  const [showTokenB, setShowTokenB] = useState(false)

  const fetchBalance = useCallback(async (token, setter) => {
    if (!account || !library) return
    try {
      if (token.address === 'NATIVE') {
        const bal = await library.getBalance(account)
        setter(ethers.utils.formatEther(bal))
      } else {
        const contract = new ethers.Contract(token.address, ERC20_ABI, library)
        const decimals = await contract.decimals()
        const bal = await contract.balanceOf(account)
        setter(ethers.utils.formatUnits(bal, decimals))
      }
    } catch {
      setter('0')
    }
  }, [account, library])

  useEffect(() => {
    fetchBalance(tokenA, setBalanceA)
  }, [tokenA, fetchBalance])

  useEffect(() => {
    fetchBalance(tokenB, setBalanceB)
  }, [tokenB, fetchBalance])

  useEffect(() => {
    if (!account || !library || tokenA.address === 'NATIVE') return
    let stale = false
    async function fetchAllowance() {
      try {
        const contract = new ethers.Contract(tokenA.address, ERC20_ABI, library)
        const dec = await contract.decimals()
        const all = await contract.allowance(account, ROUTER_ADDRESS)
        if (!stale) setAllowance(ethers.utils.formatUnits(all, dec))
      } catch {
        setAllowance('0')
      }
    }
    fetchAllowance()
    return () => { stale = true }
  }, [account, library, tokenA])

  const approve = async () => {
    if (!account || !library) return
    setApproving(true)
    try {
      const signer = library.getSigner()
      const contract = new ethers.Contract(tokenA.address, ERC20_ABI, signer)
      const tx = await contract.approve(ROUTER_ADDRESS, ethers.constants.MaxUint256)
      await tx.wait()
      addToast(`${tokenA.symbol} approved`, 'success')
      const dec = await contract.decimals()
      const all = await contract.allowance(account, ROUTER_ADDRESS)
      setAllowance(ethers.utils.formatUnits(all, dec))
    } catch (e) {
      addToast(e.message || 'Approval failed', 'error')
    } finally {
      setApproving(false)
    }
  }

  const addLiquidity = async () => {
    if (!account || !library || !amountA || !amountB) return
    setLoading(true)
    try {
      const signer = library.getSigner()
      const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer)
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20

      let tx
      if (tokenA.address === 'NATIVE') {
        tx = await router.addLiquidityETH(
          tokenB.address,
          ethers.utils.parseUnits(amountB, tokenB.decimals),
          ethers.utils.parseUnits(amountB, tokenB.decimals).mul(95).div(100),
          ethers.utils.parseUnits(amountA, tokenA.decimals).mul(95).div(100),
          account,
          deadline,
          { value: ethers.utils.parseUnits(amountA, tokenA.decimals) }
        )
      } else if (tokenB.address === 'NATIVE') {
        tx = await router.addLiquidityETH(
          tokenA.address,
          ethers.utils.parseUnits(amountA, tokenA.decimals),
          ethers.utils.parseUnits(amountA, tokenA.decimals).mul(95).div(100),
          ethers.utils.parseUnits(amountB, tokenB.decimals).mul(95).div(100),
          account,
          deadline,
          { value: ethers.utils.parseUnits(amountB, tokenB.decimals) }
        )
      } else {
        tx = await router.addLiquidity(
          tokenA.address,
          tokenB.address,
          ethers.utils.parseUnits(amountA, tokenA.decimals),
          ethers.utils.parseUnits(amountB, tokenB.decimals),
          ethers.utils.parseUnits(amountA, tokenA.decimals).mul(95).div(100),
          ethers.utils.parseUnits(amountB, tokenB.decimals).mul(95).div(100),
          account,
          deadline
        )
      }
      const receipt = await tx.wait()
      addToast(`Liquidity added: ${amountA} ${tokenA.symbol} / ${amountB} ${tokenB.symbol}`, 'success')
      const txs = JSON.parse(localStorage.getItem('swapex_transactions') || '[]')
      txs.push({ hash: receipt.transactionHash, label: `Add ${tokenA.symbol}/${tokenB.symbol}`, status: 'confirmed' })
      localStorage.setItem('swapex_transactions', JSON.stringify(txs))
      setAmountA('')
      setAmountB('')
    } catch (e) {
      addToast(e.message || 'Add liquidity failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  const needsApproval = tokenA.address !== 'NATIVE' && parseFloat(allowance) < parseFloat(amountA || '0')

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Add Liquidity</h2>

      <div className="space-y-3">
        <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--text-tertiary)]">Token A</span>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">Balance: {parseFloat(balanceA).toFixed(4)}</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              placeholder="0.0"
              value={amountA}
              onChange={(e) => setAmountA(e.target.value)}
              className="flex-1 bg-transparent text-xl font-mono text-[var(--text-primary)] outline-none"
            />
            <button
              onClick={() => setShowTokenA(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)]"
            >
              <img src={tokenA.logo} alt={tokenA.symbol} className="w-5 h-5 rounded-full" />
              {tokenA.symbol}
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex justify-center">
          <div className="w-8 h-8 rounded-full bg-[var(--bg-card)] border border-[var(--border)] flex items-center justify-center text-[var(--text-secondary)]">+</div>
        </div>

        <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--text-tertiary)]">Token B</span>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">Balance: {parseFloat(balanceB).toFixed(4)}</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              placeholder="0.0"
              value={amountB}
              onChange={(e) => setAmountB(e.target.value)}
              className="flex-1 bg-transparent text-xl font-mono text-[var(--text-primary)] outline-none"
            />
            <button
              onClick={() => setShowTokenB(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)]"
            >
              <img src={tokenB.logo} alt={tokenB.symbol} className="w-5 h-5 rounded-full" />
              {tokenB.symbol}
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        {needsApproval && (
          <button
            onClick={approve}
            disabled={approving}
            className="w-full py-3 rounded-xl font-semibold text-sm bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 transition-colors"
          >
            {approving ? 'Approving...' : `Approve ${tokenA.symbol}`}
          </button>
        )}
        <button
          onClick={addLiquidity}
          disabled={!account || !amountA || !amountB || loading || (needsApproval && tokenA.address !== 'NATIVE')}
          className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
            !account
              ? 'bg-[var(--accent)] text-white'
              : loading
              ? 'bg-[var(--accent)]/50 text-white cursor-wait'
              : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
          }`}
        >
          {!account ? 'Connect Wallet' : loading ? 'Adding Liquidity...' : 'Add Liquidity'}
        </button>
      </div>

      <TokenSelectModal open={showTokenA} onClose={() => setShowTokenA(false)} onSelect={setTokenA} />
      <TokenSelectModal open={showTokenB} onClose={() => setShowTokenB(false)} onSelect={setTokenB} />
    </div>
  )
}
