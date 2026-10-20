import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PositionsList from '../../components/PositionsList'

const state = {
  account: null,
  DEPLOYMENT: { factory: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' },
  positions: [],
  loading: false,
  error: null,
}

vi.mock('../../context/Web3Context', () => ({
  useWeb3: () => ({ account: state.account }),
}))

vi.mock('../../hooks/usePositions', () => ({
  default: () => ({ positions: state.positions, loading: state.loading, error: state.error }),
}))

vi.mock('../../lib/config', () => ({
  get DEPLOYMENT() {
    return state.DEPLOYMENT
  },
  CONFIG_ERROR: null,
  CHAINS: { 31337: { name: 'Local (anvil)' } },
  REQUIRED_CHAIN_ID: 31337,
  IS_TESTNET: true,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}))

const position = (id, { inRange = true, empty = false } = {}) => ({
  id,
  token0: { symbol: 'WETH', decimals: 18, logo: 'data:image/svg+xml;utf8,w' },
  token1: { symbol: 'tUSDC', decimals: 6, logo: 'data:image/svg+xml;utf8,u' },
  fee: 3000,
  inRange,
  liquidity: empty ? 0n : 100n,
  tickLower: -60,
  tickUpper: 60,
})

beforeEach(() => {
  vi.clearAllMocks()
  state.account = null
  state.DEPLOYMENT = { factory: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' }
  state.positions = []
  state.loading = false
  state.error = null
})

afterEach(cleanup)

describe('PositionsList', () => {
  it('shows the honest unavailable state when contracts are not deployed', () => {
    state.DEPLOYMENT = null
    render(<PositionsList />)
    expect(screen.getByRole('heading', { name: 'Pools' })).toBeTruthy()
    expect(screen.getByText(/Swapex contracts deployed on this network/)).toBeTruthy()
  })

  it('asks to connect a wallet when there is no account', () => {
    render(<PositionsList />)
    expect(screen.getByText(/Connect a wallet to see your liquidity positions/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Wallet' })).toBeTruthy()
  })

  it('shows the load-error banner when usePositions failed', () => {
    state.account = '0x1111111111111111111111111111111111111111'
    state.error = new Error('rpc down')
    render(<PositionsList />)
    expect(screen.getByText(/Could not load positions/)).toBeTruthy()
  })

  it('shows the loading status while the first fetch runs', () => {
    state.account = '0x1111111111111111111111111111111111111111'
    state.loading = true
    render(<PositionsList />)
    expect(screen.getByRole('status', { name: 'Loading positions' })).toBeTruthy()
  })

  it('shows the empty state when the account owns no positions', () => {
    state.account = '0x1111111111111111111111111111111111111111'
    render(<PositionsList />)
    expect(screen.getByText(/You have no positions yet/)).toBeTruthy()
  })

  it('lists real positions with pair, fee, range badge and detail link', () => {
    state.account = '0x1111111111111111111111111111111111111111'
    state.positions = [position('7'), position('8', { inRange: false }), position('9', { empty: true })]
    render(<PositionsList />)

    expect(screen.getAllByText('WETH / tUSDC')).toHaveLength(3)
    expect(screen.getAllByText('0.3%').length).toBe(3)
    expect(screen.getByText('In range')).toBeTruthy()
    expect(screen.getByText('Out of range')).toBeTruthy()
    expect(screen.getByText('Closed')).toBeTruthy()

    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/pool/'))
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual(['/pool/7', '/pool/8', '/pool/9'])
  })
})
