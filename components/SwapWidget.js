import React, { useState, useEffect, useMemo } from 'react'
import { Contract, utils } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI } from '../constants'
import TokenSelectModal from './TokenSelectModal'
import NetworkGuard from './NetworkGuard'
import SlippageSettings from './SlippageSettings'
import useTokenBalance from '../hooks/useTokenBalance'
import useAllowance from '../hooks/useAllowance'
import useApprove from '../hooks/useApprove'
import useTransact from '../hooks/useTransact'
import { findBestRoute } from '../lib/route'
import {
  parseAmount,
  minAfterSlippage,
  deadlineFromNow,
  formatAmount,
} from '../lib/amounts'
import { DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_MINUTES, HIGH_PRICE_IMPACT } from '../lib/config'

const GAS_RESERVE = utils.parseEther('0.01') // kept back by MAX when paying with ETH
const QUOTE_REFRESH_MS = 15000

export default function SwapWidget() {
  const { account, library } = useWeb3()
  const { run, pending: swapping } = useTransact()
  const { approve, approving } = useApprove()

  const [inputToken, setInputToken] = useState(TOKEN_LIST[0])
  const [outputToken, setOutputToken] = useState(TOKEN_LIST[2])
  const [inputAmount, setInputAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [deadlineMin, setDeadlineMin] = useState(DEFAULT_DEADLINE_MINUTES)
  const [route, setRoute] = useState(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteTick, setQuoteTick] = useState(0)
  const [showInputModal, setShowInputModal] = useState(false)
  const [showOutputModal, setShowOutputModal] = useState(false)

  const { balance: inputBalance, refetch: refetchIn } = useTokenBalance(inputToken)
  const { balance: outputBalance, refetch: refetchOut } = useTokenBalance(outputToken)
  const { needsApproval, refetch: refetchAllowance, allowance } = useAllowance(inputToken, ROUTER_ADDRESS)

  const amountIn = useMemo(() => parseAmount(inputAmount, inputToken.decimals), [inputAmount, inputToken])
  const sameToken =
    inputToken.address === outputToken.address ||
    (inputToken.symbol === 'ETH' && outputToken.symbol === 'WETH') ||
    (inputToken.symbol === 'WETH' && outputToken.symbol === 'ETH')

  // periodic re-quote so the price never goes stale while the form is open
  useEffect(() => {
    const id = setInterval(() => setQuoteTick((t) => t + 1), QUOTE_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  // Quote: debounced, and results from superseded requests are discarded.
  useEffect(() => {
    if (!library || !amountIn || sameToken) {
      setRoute(null)
      setQuoting(false)
      return
    }
    let cancelled = false
    setQuoting(true)
    const timer = setTimeout(async () => {
      try {
        const best = await findBestRoute(library, inputToken, outputToken, amountIn)
        if (!cancelled) setRoute(best)
      } catch {
        if (!cancelled) setRoute(null)
      } finally {
        if (!cancelled) setQuoting(false)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [library, amountIn, inputToken, outputToken, sameToken, quoteTick])

  const amountOut = route?.amountOut
  const minReceived = amountOut ? minAfterSlippage(amountOut, slippageBps) : null
  const insufficientBalance = amountIn ? amountIn.gt(inputBalance) : false
  const mustApprove = Boolean(route) && needsApproval(amountIn)
  const highImpact = route?.impact != null && route.impact >= HIGH_PRICE_IMPACT

  const doApprove = () =>
    approve(inputToken, ROUTER_ADDRESS, amountIn, allowance, refetchAllowance)

  const swap = async () => {
    if (!account || !library || !amountIn || !route) return
    const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library.getSigner())
    const deadline = deadlineFromNow(deadlineMin)
    const { path } = route
    const min = minReceived
    await run({
      label: `Swap ${inputToken.symbol} → ${outputToken.symbol}`,
      successMessage: `Swapped ${formatAmount(amountIn, inputToken.decimals)} ${inputToken.symbol} for ${formatAmount(amountOut, outputToken.decimals)} ${outputToken.symbol}`,
      send: () => {
        if (inputToken.address === 'NATIVE') {
          return router.swapExactETHForTokens(min, path, account, deadline, { value: amountIn })
        }
        if (outputToken.address === 'NATIVE') {
          return router.swapExactTokensForETH(amountIn, min, path, account, deadline)
        }
        return router.swapExactTokensForTokens(amountIn, min, path, account, deadline)
      },
      onSuccess: () => {
        setInputAmount('')
        setRoute(null)
        refetchIn()
        refetchOut()
        refetchAllowance()
      },
    })
  }

  const switchTokens = () => {
    setInputToken(outputToken)
    setOutputToken(inputToken)
    setInputAmount('')
    setRoute(null)
  }

  const setMax = () => {
    let max = inputBalance
    if (inputToken.address === 'NATIVE') max = max.gt(GAS_RESERVE) ? max.sub(GAS_RESERVE) : max.mul(0)
    setInputAmount(utils.formatUnits(max, inputToken.decimals))
  }

  let status = null
  if (sameToken) status = 'Choose two different tokens'
  else if (!amountIn) status = 'Enter an amount'
  else if (quoting && !route) status = 'Fetching best price...'
  else if (!route) status = 'No liquidity for this pair'
  else if (insufficientBalance) status = `Insufficient ${inputToken.symbol} balance`

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Swap</h2>

      <div className="space-y-2">
        <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-[var(--text-tertiary)] font-body">You Pay</span>
            <button
              type="button"
              onClick={setMax}
              className="text-xs text-[var(--text-tertiary)] font-mono hover:text-[var(--accent)]"
            >
              Balance: {formatAmount(inputBalance, inputToken.decimals, 4) || '0'} · MAX
            </button>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={inputAmount}
              onChange={(e) => {
                const v = e.target.value.replace(',', '.')
                if (/^\d*\.?\d*$/.test(v)) setInputAmount(v)
              }}
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
            aria-label="Switch tokens"
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
              Balance: {formatAmount(outputBalance, outputToken.decimals, 4) || '0'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="0.0"
              value={amountOut ? formatAmount(amountOut, outputToken.decimals, 8) : ''}
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

      {route && (
        <div className="mt-4 space-y-1 text-xs text-[var(--text-tertiary)] font-mono">
          <div className="flex justify-between">
            <span>Minimum received</span>
            <span>{formatAmount(minReceived, outputToken.decimals, 6)} {outputToken.symbol}</span>
          </div>
          <div className="flex justify-between">
            <span>Price impact</span>
            <span className={highImpact ? 'text-[var(--danger)]' : ''}>
              {route.impact == null ? 'n/a' : `${(route.impact * 100).toFixed(2)}%`}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Route</span>
            <span>
              {route.path
                .map((a) => TOKEN_LIST.find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol || `${a.slice(0, 6)}…`)
                .join(' → ')}
            </span>
          </div>
        </div>
      )}

      <SlippageSettings
        bps={slippageBps}
        onBpsChange={setSlippageBps}
        deadline={deadlineMin}
        onDeadlineChange={setDeadlineMin}
      />

      <NetworkGuard>
        {status ? (
          <button
            disabled
            className="w-full py-3 rounded-xl font-semibold text-sm font-display bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed"
          >
            {status}
          </button>
        ) : mustApprove ? (
          <button
            onClick={doApprove}
            disabled={approving}
            className="w-full py-3 rounded-xl font-semibold text-sm font-display bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 transition-colors disabled:cursor-wait"
          >
            {approving ? 'Approving...' : `Approve ${inputToken.symbol}`}
          </button>
        ) : (
          <button
            onClick={swap}
            disabled={swapping}
            className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
              swapping
                ? 'bg-[var(--accent)]/50 text-white cursor-wait'
                : highImpact
                ? 'bg-[var(--danger)] text-white hover:opacity-90'
                : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
            }`}
          >
            {swapping ? 'Swapping...' : highImpact ? 'Swap anyway' : 'Swap'}
          </button>
        )}
      </NetworkGuard>

      <TokenSelectModal open={showInputModal} onClose={() => setShowInputModal(false)} onSelect={setInputToken} />
      <TokenSelectModal open={showOutputModal} onClose={() => setShowOutputModal(false)} onSelect={setOutputToken} />
    </div>
  )
}
