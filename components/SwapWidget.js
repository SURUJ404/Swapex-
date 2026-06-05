import React, { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { useToast } from './Toast'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI, ERC20_ABI } from '../constants'
import TokenSelectModal from './TokenSelectModal'

const SlippageOptions = [0.1, 0.5, 1.0]

export default function SwapWidget() {
  const { account, library } = useWeb3()
  const { addToast } = useToast()

  const [inputToken, setInputToken] = useState(TOKEN_LIST[0])
  const [outputToken, setOutputToken] = useState(TOKEN_LIST[1])
  const [inputAmount, setInputAmount] = useState('')
  const [outputAmount, setOutputAmount] = useState('')
  const [slippage, setSlippage] = useState(0.5)
  const [loading, setLoading] = useState(false)
  const [inputBalance, setInputBalance] = useState('0')
  const [outputBalance, setOutputBalance] = useState('0')
  const [showInputModal, setShowInputModal] = useState(false)
  const [showOutputModal, setShowOutputModal] = useState(false)

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
    fetchBalance(inputToken, setInputBalance)
  }, [inputToken, fetchBalance])

  useEffect(() => {
    fetchBalance(outputToken, setOutputBalance)
  }, [outputToken, fetchBalance])

  useEffect(() => {
    if (!inputAmount || parseFloat(inputAmount) === 0) {
      setOutputAmount('')
      return
    }
    const timer = setTimeout(async () => {
      if (!library) return
      try {
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, library)
        const path = [inputToken.address === 'NATIVE' ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : inputToken.address,
                      outputToken.address === 'NATIVE' ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : outputToken.address]
        const amounts = await router.getAmountsOut(
          ethers.utils.parseUnits(inputAmount, inputToken.decimals),
          path
        )
        setOutputAmount(ethers.utils.formatUnits(amounts[amounts.length - 1], outputToken.decimals))
      } catch (e) {
        setOutputAmount('')
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [inputAmount, inputToken, outputToken, library])

  const swap = async () => {
    if (!account || !library || !inputAmount || !outputAmount) return
    setLoading(true)
    try {
      const signer = library.getSigner()
      const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer)
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20
      const path = [inputToken.address === 'NATIVE' ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : inputToken.address,
                    outputToken.address === 'NATIVE' ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : outputToken.address]

      let tx
      if (inputToken.address === 'NATIVE') {
        tx = await router.swapExactETHForTokens(
          ethers.utils.parseUnits(outputAmount, outputToken.decimals).mul(100 - slippage * 2).div(100),
          path,
          account,
          deadline,
          { value: ethers.utils.parseUnits(inputAmount, inputToken.decimals) }
        )
      } else if (outputToken.address === 'NATIVE') {
        tx = await router.swapExactTokensForETH(
          ethers.utils.parseUnits(inputAmount, inputToken.decimals),
          ethers.utils.parseUnits(outputAmount, outputToken.decimals).mul(100 - slippage * 2).div(100),
          path,
          account,
          deadline
        )
      } else {
        tx = await router.swapExactTokensForTokens(
          ethers.utils.parseUnits(inputAmount, inputToken.decimals),
          ethers.utils.parseUnits(outputAmount, outputToken.decimals).mul(100 - slippage * 2).div(100),
          path,
          account,
          deadline
        )
      }
      const receipt = await tx.wait()
      addToast(`Swapped ${inputAmount} ${inputToken.symbol} for ${outputAmount.slice(0, 8)} ${outputToken.symbol}`, 'success')
      const txs = JSON.parse(localStorage.getItem('swapex_transactions') || '[]')
      txs.push({ hash: receipt.transactionHash, label: `Swap ${inputToken.symbol} → ${outputToken.symbol}`, status: 'confirmed' })
      localStorage.setItem('swapex_transactions', JSON.stringify(txs))
      setInputAmount('')
      setOutputAmount('')
    } catch (e) {
      addToast(e.message || 'Swap failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  const switchTokens = () => {
    setInputToken(outputToken)
    setOutputToken(inputToken)
    setInputAmount('')
    setOutputAmount('')
  }

  const insufficientBalance = parseFloat(inputBalance) < parseFloat(inputAmount || '0')

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Swap</h2>

      <div className="space-y-2">
        <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--text-tertiary)] font-body">You Pay</span>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">
              Balance: {parseFloat(inputBalance).toFixed(4)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              placeholder="0.0"
              value={inputAmount}
              onChange={(e) => setInputAmount(e.target.value)}
              className="flex-1 bg-transparent text-xl font-mono text-[var(--text-primary)] outline-none"
            />
            <button
              onClick={() => setShowInputModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
            >
              <img src={inputToken.logo} alt={inputToken.symbol} className="w-5 h-5 rounded-full" />
              {inputToken.symbol}
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex justify-center -my-3 relative z-10">
          <button
            onClick={switchTokens}
            className="w-10 h-10 rounded-full bg-[var(--bg-card)] border border-[var(--border)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors shadow-lg"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </button>
        </div>

        <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--text-tertiary)] font-body">You Receive</span>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">
              Balance: {parseFloat(outputBalance).toFixed(4)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="0.0"
              value={outputAmount}
              readOnly
              className="flex-1 bg-transparent text-xl font-mono text-[var(--text-primary)] outline-none"
            />
            <button
              onClick={() => setShowOutputModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
            >
              <img src={outputToken.logo} alt={outputToken.symbol} className="w-5 h-5 rounded-full" />
              {outputToken.symbol}
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-[var(--text-tertiary)]">Slippage Tolerance</span>
        </div>
        <div className="flex gap-2">
          {SlippageOptions.map((s) => (
            <button
              key={s}
              onClick={() => setSlippage(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                slippage === s
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--accent)]'
              }`}
            >
              {s}%
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={swap}
        disabled={!account || !inputAmount || insufficientBalance || loading}
        className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
          !account
            ? 'bg-[var(--accent)] text-white'
            : insufficientBalance
            ? 'bg-[var(--danger-bg)] text-[var(--danger)] cursor-not-allowed'
            : loading
            ? 'bg-[var(--accent)]/50 text-white cursor-wait'
            : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
        }`}
        onClick={!account ? () => {} : undefined}
      >
        {!account ? 'Connect Wallet' : insufficientBalance ? 'Insufficient Balance' : loading ? 'Swapping...' : 'Swap'}
      </button>

      <TokenSelectModal open={showInputModal} onClose={() => setShowInputModal(false)} onSelect={setInputToken} />
      <TokenSelectModal open={showOutputModal} onClose={() => setShowOutputModal(false)} onSelect={setOutputToken} />
    </div>
  )
}
