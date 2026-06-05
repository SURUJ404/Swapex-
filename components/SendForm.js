import React, { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { useToast } from './Toast'
import { TOKEN_LIST, ERC20_ABI } from '../constants'
import TokenSelectModal from './TokenSelectModal'

export default function SendForm() {
  const { account, library } = useWeb3()
  const { addToast } = useToast()

  const [selectedToken, setSelectedToken] = useState(TOKEN_LIST[0])
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [balance, setBalance] = useState('0')
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    if (!account || !library) return
    let stale = false
    async function fetchBalance() {
      try {
        if (selectedToken.address === 'NATIVE') {
          const bal = await library.getBalance(account)
          if (!stale) setBalance(ethers.utils.formatEther(bal))
        } else {
          const contract = new ethers.Contract(selectedToken.address, ERC20_ABI, library)
          const decimals = await contract.decimals()
          const bal = await contract.balanceOf(account)
          if (!stale) setBalance(ethers.utils.formatUnits(bal, decimals))
        }
      } catch {
        if (!stale) setBalance('0')
      }
    }
    fetchBalance()
    return () => { stale = true }
  }, [selectedToken, account, library])

  const send = async () => {
    if (!account || !library || !recipient || !amount) return
    if (!ethers.utils.isAddress(recipient)) {
      addToast('Invalid recipient address', 'error')
      return
    }
    if (parseFloat(amount) > parseFloat(balance)) {
      addToast('Insufficient balance', 'error')
      return
    }
    setLoading(true)
    try {
      const signer = library.getSigner()
      let tx
      if (selectedToken.address === 'NATIVE') {
        tx = await signer.sendTransaction({
          to: recipient,
          value: ethers.utils.parseEther(amount),
        })
      } else {
        const contract = new ethers.Contract(selectedToken.address, ERC20_ABI, signer)
        const decimals = await contract.decimals()
        tx = await contract.transfer(recipient, ethers.utils.parseUnits(amount, decimals))
      }
      const receipt = await tx.wait()
      addToast(`Sent ${amount} ${selectedToken.symbol} to ${recipient.slice(0, 6)}...`, 'success')
      const txs = JSON.parse(localStorage.getItem('swapex_transactions') || '[]')
      txs.push({ hash: receipt.transactionHash, label: `Send ${selectedToken.symbol}`, status: 'confirmed' })
      localStorage.setItem('swapex_transactions', JSON.stringify(txs))
      setAmount('')
      setRecipient('')
    } catch (e) {
      addToast(e.message || 'Send failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Send</h2>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-[var(--text-tertiary)] mb-1 block">Asset</label>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
          >
            <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-5 h-5 rounded-full" />
            {selectedToken.symbol}
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        <div>
          <label className="text-xs text-[var(--text-tertiary)] mb-1 block">Recipient Address</label>
          <input
            type="text"
            placeholder="0x..."
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-[var(--text-tertiary)]">Amount</label>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">
              Balance: {parseFloat(balance).toFixed(4)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-lg font-mono outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={() => setAmount(balance)}
              className="px-3 py-2 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] text-xs font-medium hover:bg-[var(--accent)]/20 transition-colors"
            >
              MAX
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={send}
        disabled={!account || !recipient || !amount || loading}
        className={`w-full mt-6 py-3 rounded-xl font-semibold text-sm font-display transition-all ${
          !account
            ? 'bg-[var(--accent)] text-white'
            : loading
            ? 'bg-[var(--accent)]/50 text-white cursor-wait'
            : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
        }`}
      >
        {!account ? 'Connect Wallet' : loading ? 'Sending...' : 'Send'}
      </button>

      <TokenSelectModal open={showModal} onClose={() => setShowModal(false)} onSelect={setSelectedToken} />
    </div>
  )
}
