import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmSwapModal from '../../components/ConfirmSwapModal'

const baseProps = () => ({
  open: true,
  onClose: vi.fn(),
  onConfirm: vi.fn(),
  pending: false,
  inputToken: { symbol: 'WETH', decimals: 18 },
  outputToken: { symbol: 'tUSDC', decimals: 6 },
  amountIn: '1000000000000000000', // 1 WETH
  amountOut: '2000000000', // 2000 tUSDC
  minReceived: '1990000000', // 1990 tUSDC
  route: { tokens: [], fees: [] },
  impact: 0.001,
  slippageBps: 50,
  deadlineMin: 20,
  gasEstimate: '150000',
  gasPrice: '1000000000',
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('ConfirmSwapModal', () => {
  it('renders the review summary with amounts, rate, impact, minimum and settings', () => {
    render(<ConfirmSwapModal {...baseProps()} />)
    expect(screen.getByRole('heading', { name: 'Confirm swap' })).toBeTruthy()
    expect(screen.getByText('1 WETH')).toBeTruthy()
    expect(screen.getByText('2000 tUSDC')).toBeTruthy()
    expect(screen.getByText(/Rate/)).toBeTruthy()
    expect(screen.getByText('0.10%')).toBeTruthy() // impact 0.001
    expect(screen.getByText(/Minimum received/)).toBeTruthy()
    expect(screen.getByText(/Slippage tolerance/)).toBeTruthy()
    expect(screen.getByText('0.5%')).toBeTruthy() // 50 bps
    expect(screen.getByText(/Transaction deadline/)).toBeTruthy()
    expect(screen.getByText('20 min')).toBeTruthy()
    expect(screen.getByText(/Estimated network fee/)).toBeTruthy()
    expect(screen.getByText(/0.00015 ETH/)).toBeTruthy() // 150k gas * 1 gwei
  })

  it('confirms in one click below the impact threshold', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<ConfirmSwapModal {...props} />)
    await user.click(screen.getByRole('button', { name: 'Confirm swap' }))
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('needs a second explicit confirm at or above 5% impact', async () => {
    const user = userEvent.setup()
    const props = { ...baseProps(), impact: 0.06 }
    render(<ConfirmSwapModal {...props} />)

    // high-impact warning + red "Confirm anyway" first step
    expect(screen.getByText(/Price impact is high/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Confirm anyway' }))
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByText(/Price impact is high/)).toBeNull()

    // second click runs the real confirm
    await user.click(screen.getByRole('button', { name: 'Confirm swap' }))
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancel calls onClose and does not confirm', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<ConfirmSwapModal {...props} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('disables both actions while a swap is pending', () => {
    const props = { ...baseProps(), pending: true }
    render(<ConfirmSwapModal {...props} />)
    expect(screen.getByRole('button', { name: 'Swapping…' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
  })

  it('resets the high-impact acknowledgement when reopened', async () => {
    const user = userEvent.setup()
    const props = { ...baseProps(), impact: 0.06, open: false }
    const { rerender } = render(<ConfirmSwapModal {...props} />)

    rerender(<ConfirmSwapModal {...props} open />)
    await user.click(screen.getByRole('button', { name: 'Confirm anyway' }))
    expect(screen.queryByText(/Price impact is high/)).toBeNull()

    // close and reopen: the warning must come back, not carry over the ack.
    // The reset effect defers setAcknowledged(false) to a microtask.
    rerender(<ConfirmSwapModal {...props} open={false} />)
    rerender(<ConfirmSwapModal {...props} open />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText(/Price impact is high/)).toBeTruthy()
  })
})
