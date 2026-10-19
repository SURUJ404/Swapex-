import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NetworkGuard from '../../components/NetworkGuard'

// Mutable module state: NetworkGuard reads these bindings at render time.
const state = {
  account: null,
  wrongNetwork: false,
  switchNetwork: vi.fn(),
  setWalletModalOpen: vi.fn(),
  CONFIG_ERROR: null,
}

vi.mock('../../context/Web3Context', () => ({
  useWeb3: () => ({
    account: state.account,
    wrongNetwork: state.wrongNetwork,
    switchNetwork: state.switchNetwork,
    setWalletModalOpen: state.setWalletModalOpen,
  }),
}))

vi.mock('../../lib/config', () => ({
  get CONFIG_ERROR() {
    return state.CONFIG_ERROR
  },
  CHAINS: { 31337: { name: 'Local (anvil)' } },
  REQUIRED_CHAIN_ID: 31337,
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.account = null
  state.wrongNetwork = false
  state.CONFIG_ERROR = null
})

afterEach(cleanup)

describe('NetworkGuard', () => {
  it('renders a disabled Unavailable button when the build is misconfigured', () => {
    state.CONFIG_ERROR = 'Swapex contracts are not deployed on Local (anvil) yet.'
    render(
      <NetworkGuard>
        <button type="button">Swap</button>
      </NetworkGuard>
    )
    const btn = screen.getByRole('button', { name: 'Unavailable on this network' })
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('not deployed')
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull()
  })

  it('offers Connect Wallet when no account is connected', async () => {
    const user = userEvent.setup()
    render(
      <NetworkGuard>
        <button type="button">Swap</button>
      </NetworkGuard>
    )
    const btn = screen.getByRole('button', { name: 'Connect Wallet' })
    await user.click(btn)
    expect(state.setWalletModalOpen).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull()
  })

  it('offers a network switch when connected on the wrong chain', async () => {
    const user = userEvent.setup()
    state.account = '0x1111111111111111111111111111111111111111'
    state.wrongNetwork = true
    render(
      <NetworkGuard>
        <button type="button">Swap</button>
      </NetworkGuard>
    )
    const btn = screen.getByRole('button', { name: 'Switch to Local (anvil)' })
    await user.click(btn)
    expect(state.switchNetwork).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull()
  })

  it('renders the guarded children when connected on the right chain', () => {
    state.account = '0x1111111111111111111111111111111111111111'
    render(
      <NetworkGuard>
        <button type="button">Swap</button>
      </NetworkGuard>
    )
    expect(screen.getByRole('button', { name: 'Swap' })).toBeTruthy()
  })
})
