import React, { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { BigNumber } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import Skeleton from './Skeleton'
import {
  collect as pmCollect,
  increaseLiquidity as pmIncreaseLiquidity,
  burn as pmBurn,
  multicall as pmMulticall,
  encodeDecreaseLiquidity,
  encodeCollect,
  encodeUnwrapWETH9,
  encodeSweepToken,
  ADDRESS_THIS,
  MAX_UINT128,
} from '../lib/contracts/positionManager'
import { DEPLOYMENT, DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_MINUTES, WETH_ADDRESS } from '../lib/config'
import { formatAmount, minAfterSlippage, deadlineFromNow, parseAmount } from '../lib/amounts'
import { amountsForLiquidity, amountsForDeposit, toIntegerString } from '../lib/liquidity'
import { tickToPrice, formatPrice, usableRange, tickSpacingFor } from '../lib/ticks'
import { loadPosition } from '../hooks/usePositions'
import useTokenBalance from '../hooks/useTokenBalance'
import useAllowance from '../hooks/useAllowance'
import useApprove from '../hooks/useApprove'
import useTransact from '../hooks/useTransact'
import NetworkGuard from './NetworkGuard'
import SlippageSettings from './SlippageSettings'
import DataUnavailable from './DataUnavailable'
import { RangeBadge } from './PositionsList'

export default function PositionDetail({ tokenId }) {
  if (!DEPLOYMENT) return <DataUnavailable title="Position" needs="Swapex contracts deployed on this network" />
  return <Detail tokenId={tokenId} />
}

function bnToNumber(bn) {
  return Number(BigNumber.from(bn).toString())
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between text-sm py-1">
      <span className="text-[var(--text-tertiary)]">{k}</span>
      <span className="font-mono text-[var(--text-primary)]">{v}</span>
    </div>
  )
}

function Detail({ tokenId }) {
  const router = useRouter()
  const { account, library } = useWeb3()
  const { run, pending } = useTransact()
  const { approve, approving } = useApprove()

  const [pos, setPos] = useState(null)
  const [error, setError] = useState(null)
  const [percent, setPercent] = useState(100)
  const [receiveEth, setReceiveEth] = useState(false)
  const [addAmount0, setAddAmount0] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [deadlineMin, setDeadlineMin] = useState(DEFAULT_DEADLINE_MINUTES)

  const refetch = useCallback(async () => {
    if (!library || tokenId == null) return
    try {
      setError(null)
      setPos(await loadPosition(library, tokenId))
    } catch (e) {
      setError(e)
    }
  }, [library, tokenId])

  useEffect(() => {
    Promise.resolve()
      .then(() => refetch())
      .catch(() => {})
  }, [refetch])

  const t0 = pos?.token0
  const t1 = pos?.token1
  const bal0 = useTokenBalance(t0)
  const bal1 = useTokenBalance(t1)
  const allow0 = useAllowance(t0, DEPLOYMENT.positionManager)
  const allow1 = useAllowance(t1, DEPLOYMENT.positionManager)

  const isOwner = Boolean(pos && account && pos.owner.toLowerCase() === account.toLowerCase())
  const sqrtP = pos ? Number(pos.sqrtPriceX96) / 2 ** 96 : null

  // what the position is worth now
  const worth = useMemo(
    () => (pos ? amountsForLiquidity(sqrtP, pos.tickLower, pos.tickUpper, bnToNumber(pos.liquidity)) : null),
    [pos, sqrtP]
  )

  const removeLiquidity = pos ? pos.liquidity.mul(percent).div(100) : null
  const removeEst = useMemo(
    () => (pos && removeLiquidity ? amountsForLiquidity(sqrtP, pos.tickLower, pos.tickUpper, bnToNumber(removeLiquidity)) : null),
    [pos, sqrtP, removeLiquidity]
  )

  const hasWeth = pos && WETH_ADDRESS && [pos.token0.address, pos.token1.address].some((a) => a.toLowerCase() === WETH_ADDRESS.toLowerCase())

  const collectOnly = () =>
    run({
      label: `Collect fees #${pos.id}`,
      successMessage: 'Fees collected',
      send: () => pmCollect(library.getSigner(), { tokenId: pos.id, recipient: account, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }),
      onSuccess: refetch,
    })

  const remove = () => {
    const signer = library.getSigner()
    const calls = [
      encodeDecreaseLiquidity({
        tokenId: pos.id,
        liquidity: removeLiquidity,
        amount0Min: minAfterSlippage(BigNumber.from(toIntegerString(removeEst.amount0)), slippageBps),
        amount1Min: minAfterSlippage(BigNumber.from(toIntegerString(removeEst.amount1)), slippageBps),
        deadline: deadlineFromNow(deadlineMin),
      }),
    ]
    if (receiveEth && hasWeth) {
      // collect into the contract, then turn WETH into ETH and send the other token on
      calls.push(encodeCollect({ tokenId: pos.id, recipient: ADDRESS_THIS, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }))
      calls.push(encodeUnwrapWETH9(0, account))
      const other = pos.token0.address.toLowerCase() === WETH_ADDRESS.toLowerCase() ? pos.token1.address : pos.token0.address
      calls.push(encodeSweepToken(other, 0, account))
    } else {
      calls.push(encodeCollect({ tokenId: pos.id, recipient: account, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }))
    }
    return run({
      label: `Remove ${percent}% of #${pos.id}`,
      successMessage: 'Liquidity removed',
      send: () => pmMulticall(signer, calls),
      onSuccess: refetch,
    })
  }

  // ---- add liquidity (enter token0, token1 follows from the range)
  const raw0 = t0 ? parseAmount(addAmount0, t0.decimals) : null
  const addPrediction = useMemo(() => {
    if (!pos || !raw0 || pos.currentTick >= pos.tickUpper) return null
    return amountsForDeposit(sqrtP, pos.tickLower, pos.tickUpper, { token: 0, amount: bnToNumber(raw0) })
  }, [pos, raw0, sqrtP])
  const need1 = addPrediction ? BigNumber.from(toIntegerString(addPrediction.amount1)) : BigNumber.from(0)
  const canAdd = Boolean(addPrediction)
  const insufficient0 = raw0 && raw0.gt(bal0.balance)
  const insufficient1 = need1.gt(bal1.balance)
  const mustApprove0 = raw0 && allow0.needsApproval(raw0)
  const mustApprove1 = need1.gt(0) && allow1.needsApproval(need1)

  const add = () =>
    run({
      label: `Add liquidity to #${pos.id}`,
      successMessage: 'Liquidity added',
      send: () =>
        pmIncreaseLiquidity(library.getSigner(), {
          tokenId: pos.id,
          amount0Desired: raw0,
          amount1Desired: need1,
          amount0Min: minAfterSlippage(raw0, slippageBps),
          amount1Min: minAfterSlippage(need1, slippageBps),
          deadline: deadlineFromNow(deadlineMin),
        }),
      onSuccess: () => {
        setAddAmount0('')
        refetch()
        bal0.refetch && bal0.refetch()
        bal1.refetch && bal1.refetch()
      },
    })

  const burn = () =>
    run({ label: `Close position #${pos.id}`, successMessage: 'Position closed', send: () => pmBurn(library.getSigner(), pos.id), onSuccess: () => router.push('/pool') })

  if (error) {
    return <DataUnavailable title="Position not found" needs="a position you own on this network" />
  }
  if (!pos)
    return (
      <div role="status" aria-label="Loading position" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 space-y-4">
        <span className="sr-only">Loading position…</span>
        <div className="flex items-center gap-3">
          <Skeleton className="w-8 h-8 rounded-full" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )

  const spacing = tickSpacingFor(pos.fee)
  const { min, max } = usableRange(spacing)
  const lo = pos.tickLower <= min ? '0' : formatPrice(tickToPrice(pos.tickLower, t0.decimals, t1.decimals))
  const hi = pos.tickUpper >= max ? '∞' : formatPrice(tickToPrice(pos.tickUpper, t0.decimals, t1.decimals))
  const cur = formatPrice(tickToPrice(pos.currentTick, t0.decimals, t1.decimals))
  const closed = pos.liquidity.isZero()
  const owed0 = pos.tokensOwed0
  const owed1 = pos.tokensOwed1

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <Link href="/pool" className="text-sm text-[var(--text-secondary)] no-underline hover:text-[var(--text-primary)]">← Positions</Link>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              <img src={t0.logo} alt="" className="w-8 h-8 rounded-full border border-[var(--bg-card)]" />
              <img src={t1.logo} alt="" className="w-8 h-8 rounded-full border border-[var(--bg-card)]" />
            </div>
            <h1 className="text-xl font-semibold">{t0.symbol} / {t1.symbol}</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{pos.fee / 10000}%</span>
          </div>
          <RangeBadge inRange={pos.inRange} empty={closed} />
        </div>

        <Row k="Position" v={`#${pos.id}`} />
        <Row k={`Range (${t1.symbol} per ${t0.symbol})`} v={`${lo} – ${hi}`} />
        <Row k="Current price" v={cur} />
        {worth && !closed && (
          <>
            <Row k={`Pooled ${t0.symbol}`} v={formatAmount(BigNumber.from(toIntegerString(worth.amount0)), t0.decimals, 6)} />
            <Row k={`Pooled ${t1.symbol}`} v={formatAmount(BigNumber.from(toIntegerString(worth.amount1)), t1.decimals, 6)} />
          </>
        )}
        <Row k={`Fees credited ${t0.symbol}`} v={formatAmount(owed0, t0.decimals, 6) || '0'} />
        <Row k={`Fees credited ${t1.symbol}`} v={formatAmount(owed1, t1.decimals, 6) || '0'} />
        <p className="text-xs text-[var(--text-tertiary)] mt-2">
          Fees earned since the last action are added when you collect, so the amount you receive can be higher than shown.
        </p>
      </div>

      {!isOwner ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--text-secondary)]">
          You do not own this position, so you can only view it.
        </div>
      ) : (
        <NetworkGuard>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 space-y-4">
            <h2 className="font-semibold">Collect fees</h2>
            <button disabled={pending} onClick={collectOnly} className="w-full py-3 rounded-xl font-semibold text-sm bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
              {pending ? 'Working…' : 'Collect fees'}
            </button>
          </div>

          {!closed && (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 space-y-3">
              <h2 className="font-semibold">Add liquidity</h2>
              {pos.currentTick >= pos.tickUpper ? (
                <p className="text-sm text-yellow-500">The price is above this range, so only {t1.symbol} could be added. Use a new position instead.</p>
              ) : (
                <>
                  <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
                    <div className="flex justify-between text-xs text-[var(--text-tertiary)] mb-1">
                      <span>{t0.symbol}</span>
                      <span className="font-mono">Balance: {formatAmount(bal0.balance, t0.decimals, 4) || '0'}</span>
                    </div>
                    <label htmlFor="pos-add-amount" className="sr-only">Amount of {t0.symbol} to add</label>
                    <input
                      id="pos-add-amount"
                      value={addAmount0}
                      onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setAddAmount0(e.target.value)}
                      placeholder="0.0"
                      inputMode="decimal"
                      className="w-full bg-transparent font-mono text-lg outline-none"
                    />
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)] font-mono">
                    Also needs {formatAmount(need1, t1.decimals, 6) || '0'} {t1.symbol}
                  </div>
                  {!canAdd ? (
                    <button disabled className="w-full py-3 rounded-xl text-sm font-semibold bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">Enter an amount</button>
                  ) : insufficient0 || insufficient1 ? (
                    <button disabled className="w-full py-3 rounded-xl text-sm font-semibold bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">Insufficient balance</button>
                  ) : mustApprove0 ? (
                    <button disabled={approving} onClick={() => approve(t0, DEPLOYMENT.positionManager, raw0, allow0.allowance, allow0.refetch)} className="w-full py-3 rounded-xl text-sm font-semibold bg-yellow-500/20 text-yellow-500">
                      {approving ? 'Approving…' : `Approve ${t0.symbol}`}
                    </button>
                  ) : mustApprove1 ? (
                    <button disabled={approving} onClick={() => approve(t1, DEPLOYMENT.positionManager, need1, allow1.allowance, allow1.refetch)} className="w-full py-3 rounded-xl text-sm font-semibold bg-yellow-500/20 text-yellow-500">
                      {approving ? 'Approving…' : `Approve ${t1.symbol}`}
                    </button>
                  ) : (
                    <button disabled={pending} onClick={add} className="w-full py-3 rounded-xl text-sm font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
                      {pending ? 'Adding…' : 'Add liquidity'}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {!closed && (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 space-y-3">
              <h2 className="font-semibold">Remove liquidity</h2>
              <div className="flex items-center justify-between">
                <span className="text-3xl font-mono">{percent}%</span>
                <div className="flex gap-2">
                  {[25, 50, 75, 100].map((p) => (
                    <button key={p} onClick={() => setPercent(p)} className={`px-3 py-1 rounded-full text-xs border ${percent === p ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}>
                      {p === 100 ? 'Max' : `${p}%`}
                    </button>
                  ))}
                </div>
              </div>
              <input type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} className="w-full" aria-label="Percent of liquidity to remove" />
              {removeEst && (
                <div className="text-xs text-[var(--text-tertiary)] font-mono space-y-1">
                  <div>You receive about {formatAmount(BigNumber.from(toIntegerString(removeEst.amount0)), t0.decimals, 6)} {t0.symbol}</div>
                  <div>and about {formatAmount(BigNumber.from(toIntegerString(removeEst.amount1)), t1.decimals, 6)} {t1.symbol}, plus fees</div>
                </div>
              )}
              {hasWeth && (
                <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <input type="checkbox" checked={receiveEth} onChange={(e) => setReceiveEth(e.target.checked)} aria-label="Receive ETH instead of WETH" /> Receive ETH instead of WETH
                </label>
              )}
              <SlippageSettings bps={slippageBps} onBpsChange={setSlippageBps} deadline={deadlineMin} onDeadlineChange={setDeadlineMin} />
              <button disabled={pending} onClick={remove} className="w-full py-3 rounded-xl text-sm font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
                {pending ? 'Removing…' : 'Remove liquidity'}
              </button>
            </div>
          )}

          {closed && owed0.isZero() && owed1.isZero() && (
            <button disabled={pending} onClick={burn} className="w-full py-3 rounded-xl text-sm font-semibold border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              Close position (burn NFT)
            </button>
          )}
        </NetworkGuard>
      )}
    </div>
  )
}
