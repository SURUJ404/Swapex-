import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Contract, BigNumber, utils } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI, PAIR_ABI, ERC20_ABI } from '../constants'
import NetworkGuard from './NetworkGuard'
import SlippageSettings from './SlippageSettings'
import useApprove from '../hooks/useApprove'
import useTransact from '../hooks/useTransact'
import { minAfterSlippage, deadlineFromNow, formatAmount } from '../lib/amounts'
import { WETH_ADDRESS, DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_MINUTES } from '../lib/config'

const PERCENTS = [25, 50, 75, 100]

function tokenInfo(address) {
  return TOKEN_LIST.find((t) => t.address.toLowerCase() === address.toLowerCase())
}

export default function RemoveLiquidityForm() {
  const { account, library, wrongNetwork } = useWeb3()
  const { run, pending: removing } = useTransact()
  const { approve, approving } = useApprove()

  const [pairAddress, setPairAddress] = useState('')
  const [info, setInfo] = useState(null)
  const [percent, setPercent] = useState(0)
  const [receiveEth, setReceiveEth] = useState(true)
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [deadlineMin, setDeadlineMin] = useState(DEFAULT_DEADLINE_MINUTES)

  const validPair = utils.isAddress(pairAddress)

  const fetchPairInfo = useCallback(async () => {
    if (!library || !account || !validPair || wrongNetwork) {
      setInfo(null)
      return
    }
    try {
      const pair = new Contract(pairAddress, PAIR_ABI, library)
      const [token0, token1, reserves, totalSupply, lpBalance, lpAllowance] = await Promise.all([
        pair.token0(),
        pair.token1(),
        pair.getReserves(),
        pair.totalSupply(),
        pair.balanceOf(account),
        pair.allowance(account, ROUTER_ADDRESS),
      ])
      const dec = async (a) => tokenInfo(a)?.decimals ?? (await new Contract(a, ERC20_ABI, library).decimals())
      const [dec0, dec1] = await Promise.all([dec(token0), dec(token1)])
      setInfo({
        token0, token1, dec0, dec1,
        reserve0: reserves._reserve0, reserve1: reserves._reserve1,
        totalSupply, lpBalance, lpAllowance,
      })
    } catch {
      setInfo(null)
    }
  }, [library, account, pairAddress, validPair, wrongNetwork])

  useEffect(() => {
    setPercent(0)
    fetchPairInfo()
  }, [fetchPairInfo])

  const liquidity = useMemo(
    () => (info ? info.lpBalance.mul(percent).div(100) : BigNumber.from(0)),
    [info, percent]
  )

  // what the user gets back, from pool share
  const out = useMemo(() => {
    if (!info || info.totalSupply.isZero() || liquidity.isZero()) return null
    return {
      a0: liquidity.mul(info.reserve0).div(info.totalSupply),
      a1: liquidity.mul(info.reserve1).div(info.totalSupply),
    }
  }, [info, liquidity])

  const hasWeth = info && [info.token0, info.token1].some((t) => t.toLowerCase() === WETH_ADDRESS.toLowerCase())
  const sym = (addr, native) => (native ? 'ETH' : tokenInfo(addr)?.symbol || `${addr.slice(0, 6)}…`)
  const useNative = Boolean(hasWeth && receiveEth)
  const needsLpApproval = Boolean(info && liquidity.gt(0) && info.lpAllowance.lt(liquidity))

  const approveLp = () =>
    approve({ address: pairAddress, symbol: 'LP' }, ROUTER_ADDRESS, liquidity, info.lpAllowance, fetchPairInfo)

  const removeLiquidity = async () => {
    if (!account || !library || !info || !out || liquidity.isZero()) return
    const router = new Contract(ROUTER_ADDRESS, ROUTER_ABI, library.getSigner())
    const deadline = deadlineFromNow(deadlineMin)
    const min0 = minAfterSlippage(out.a0, slippageBps)
    const min1 = minAfterSlippage(out.a1, slippageBps)
    await run({
      label: 'Remove Liquidity',
      successMessage: 'Liquidity removed',
      send: () => {
        if (useNative) {
          const token0IsWeth = info.token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          const token = token0IsWeth ? info.token1 : info.token0
          const minToken = token0IsWeth ? min1 : min0
          const minEth = token0IsWeth ? min0 : min1
          return router.removeLiquidityETH(token, liquidity, minToken, minEth, account, deadline)
        }
        return router.removeLiquidity(info.token0, info.token1, liquidity, min0, min1, account, deadline)
      },
      onSuccess: () => {
        setPercent(0)
        fetchPairInfo()
      },
    })
  }

  let status = null
  if (!validPair) status = 'Enter a pair address'
  else if (!info) status = 'Loading pair...'
  else if (info.lpBalance.isZero()) status = 'You have no liquidity in this pair'
  else if (percent === 0) status = 'Choose an amount'

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
            onChange={(e) => setPairAddress(e.target.value.trim())}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
          {pairAddress && !validPair && (
            <p className="text-xs text-[var(--danger)] mt-1">Not a valid address</p>
          )}
        </div>

        {info && (
          <div className="bg-[var(--bg-secondary)] rounded-xl p-3 text-sm">
            <p className="text-[var(--text-tertiary)]">
              Pair:{' '}
              <span className="text-[var(--text-primary)] font-mono">
                {sym(info.token0)} / {sym(info.token1)}
              </span>
            </p>
            <p className="text-[var(--text-tertiary)] mt-1">
              LP Balance:{' '}
              <span className="text-[var(--text-primary)] font-mono">{formatAmount(info.lpBalance, 18, 6) || '0'}</span>
            </p>
          </div>
        )}

        {info && !info.lpBalance.isZero() && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-[var(--text-tertiary)]">Amount to remove</label>
              <span className="text-lg font-mono text-[var(--text-primary)]">{percent}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
            <div className="flex gap-2 mt-2">
              {PERCENTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPercent(p)}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] text-xs font-medium hover:bg-[var(--accent)]/20 transition-colors"
                >
                  {p === 100 ? 'MAX' : `${p}%`}
                </button>
              ))}
            </div>
          </div>
        )}

        {out && (
          <div className="bg-[var(--bg-secondary)] rounded-xl p-3 text-sm font-mono space-y-1">
            <p className="text-xs text-[var(--text-tertiary)] font-body">You will receive (minimum shown after slippage)</p>
            {[
              { addr: info.token0, amt: out.a0, dec: info.dec0 },
              { addr: info.token1, amt: out.a1, dec: info.dec1 },
            ].map(({ addr, amt, dec }) => {
              const native = useNative && addr.toLowerCase() === WETH_ADDRESS.toLowerCase()
              return (
                <p key={addr} className="flex justify-between text-[var(--text-primary)]">
                  <span>{sym(addr, native)}</span>
                  <span>
                    {formatAmount(amt, dec, 6)}{' '}
                    <span className="text-[var(--text-tertiary)]">(≥ {formatAmount(minAfterSlippage(amt, slippageBps), dec, 6)})</span>
                  </span>
                </p>
              )
            })}
          </div>
        )}

        {hasWeth && (
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={receiveEth} onChange={(e) => setReceiveEth(e.target.checked)} />
            Receive ETH instead of WETH
          </label>
        )}
      </div>

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
        ) : needsLpApproval ? (
          <button
            onClick={approveLp}
            disabled={approving}
            className="w-full py-3 rounded-xl font-semibold text-sm font-display bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 transition-colors"
          >
            {approving ? 'Approving...' : 'Approve LP tokens'}
          </button>
        ) : (
          <button
            onClick={removeLiquidity}
            disabled={removing}
            className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
              removing ? 'bg-[var(--danger)]/50 text-white cursor-wait' : 'bg-[var(--danger)] text-white hover:opacity-90'
            }`}
          >
            {removing ? 'Removing...' : 'Remove Liquidity'}
          </button>
        )}
      </NetworkGuard>
    </div>
  )
}
