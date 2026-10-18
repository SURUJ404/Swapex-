import React, { useState, useMemo } from 'react'
import { utils } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { transfer } from '../lib/contracts/erc20'
import { TOKENS as TOKEN_LIST } from '../lib/tokens'
import TokenSelectModal from './TokenSelectModal'
import NetworkGuard from './NetworkGuard'
import useTokenBalance from '../hooks/useTokenBalance'
import useTransact from '../hooks/useTransact'
import { parseAmount, formatAmount } from '../lib/amounts'

const GAS_RESERVE = utils.parseEther('0.01')

export default function SendForm() {
  const { account, library } = useWeb3()
  const { run, pending: loading } = useTransact()

  const [selectedToken, setSelectedToken] = useState(TOKEN_LIST[0])
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [showModal, setShowModal] = useState(false)

  const { balance, refetch } = useTokenBalance(selectedToken)
  const amountBn = useMemo(() => parseAmount(amount, selectedToken.decimals), [amount, selectedToken])
  const validRecipient = utils.isAddress(recipient)

  const setMax = () => {
    let max = balance
    if (selectedToken.address === 'NATIVE') max = max.gt(GAS_RESERVE) ? max.sub(GAS_RESERVE) : max.mul(0)
    setAmount(utils.formatUnits(max, selectedToken.decimals))
  }

  let status = null
  if (!validRecipient) status = recipient ? 'Invalid recipient address' : 'Enter a recipient'
  else if (!amountBn) status = 'Enter an amount'
  else if (amountBn.gt(balance)) status = `Insufficient ${selectedToken.symbol} balance`

  const send = async () => {
    if (!account || !library || !amountBn || !validRecipient) return
    const signer = library.getSigner()
    await run({
      label: `Send ${selectedToken.symbol}`,
      successMessage: `Sent ${formatAmount(amountBn, selectedToken.decimals)} ${selectedToken.symbol} to ${recipient.slice(0, 6)}...`,
      send: () =>
        selectedToken.address === 'NATIVE'
          ? signer.sendTransaction({ to: recipient, value: amountBn })
          : transfer(signer, selectedToken.address, recipient, amountBn),
      onSuccess: () => {
        setAmount('')
        setRecipient('')
        refetch()
      },
    })
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Send</h2>

      <div className="space-y-4">
        <div>
          <label htmlFor="send-asset" className="text-xs text-[var(--text-tertiary)] mb-1 block">Asset</label>
          <button
            id="send-asset"
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
          >
            <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-5 h-5 rounded-full" />
            {selectedToken.symbol}
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        <div>
          <label htmlFor="send-recipient" className="text-xs text-[var(--text-tertiary)] mb-1 block">Recipient Address</label>
          <input
            id="send-recipient"
            type="text"
            placeholder="0x..."
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.trim())}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="send-amount" className="text-xs text-[var(--text-tertiary)]">Amount</label>
            <span className="text-xs text-[var(--text-tertiary)] font-mono">
              Balance: {formatAmount(balance, selectedToken.decimals, 4) || '0'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="send-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => {
                const v = e.target.value.replace(',', '.')
                if (/^\d*\.?\d*$/.test(v)) setAmount(v)
              }}
              className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-lg font-mono outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={setMax}
              className="px-3 py-2 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] text-xs font-medium hover:bg-[var(--accent)]/20 transition-colors"
            >
              MAX
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <NetworkGuard>
          <button
            onClick={send}
            disabled={Boolean(status) || loading}
            className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
              status
                ? 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed'
                : loading
                ? 'bg-[var(--accent)]/50 text-white cursor-wait'
                : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
            }`}
          >
            {status || (loading ? 'Sending...' : 'Send')}
          </button>
        </NetworkGuard>
      </div>

      <TokenSelectModal open={showModal} onClose={() => setShowModal(false)} onSelect={setSelectedToken} />
    </div>
  )
}
