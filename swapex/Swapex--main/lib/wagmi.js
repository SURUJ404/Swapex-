// wagmi v2 + viem configuration: chains built from lib/config's CHAINS map,
// injected (MetaMask and friends) + Coinbase Wallet connectors.
// Reads go through the injected wallet's provider when one is present — the same
// semantics the old ethers app had (all reads via `library`), and CSP-safe: wallets
// proxy RPC from the page origin instead of a direct cross-origin fetch to http RPC.
// Without a wallet, fall back to the chain's public RPC (https; local anvil only
// works in dev mode, where connect-src allows http://127.0.0.1).
// Polling matches the old ethers interval (12s) so balances refresh at the same cadence.
import { createConfig, custom, http } from 'wagmi'
import { injected, coinbaseWallet } from 'wagmi/connectors'
import { defineChain } from 'viem'
import { CHAINS, REQUIRED_CHAIN_ID } from './config'

function toViemChain(id) {
  const c = CHAINS[id]
  return defineChain({
    id,
    name: c.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
    blockExplorers: c.explorer ? { default: { name: c.name, url: c.explorer } } : undefined,
    testnet: c.testnet,
  })
}

// the required chain first, so wagmi's default chain matches the app's target network
const CHAIN_IDS = [...new Set([REQUIRED_CHAIN_ID, ...Object.keys(CHAINS).map(Number)])].filter((id) => CHAINS[id])

function transportFor(id) {
  if (typeof window !== 'undefined' && window.ethereum) {
    // retryCount 0: a PoolNotFound revert (a missing fee tier) is a valid answer,
    // not a transient failure — wagmi's own wallet transport disables retries too.
    return custom(window.ethereum, { pollingInterval: 12000, retryCount: 0 })
  }
  return http(CHAINS[id].rpc, { pollingInterval: 12000, retryCount: 0 })
}

export const injectedConnector = injected()
export const coinbaseConnector = coinbaseWallet({ appName: 'SWAPEX' })

/** Wallet entries rendered by the connect modal. `id` matches the wagmi connector id. */
export const WALLETS = [
  {
    id: 'injected',
    name: 'MetaMask',
    description: 'Connect using browser extension',
    icon: '/images/wallets/metamask.png',
    color: '#E8831D',
  },
  {
    id: 'coinbaseWalletSDK',
    name: 'Coinbase Wallet',
    description: 'Use Coinbase Wallet app',
    icon: '/images/wallets/coinbase.svg',
    color: '#315CF5',
  },
]

export const wagmiConfig = createConfig({
  chains: CHAIN_IDS.map(toViemChain),
  connectors: [injectedConnector, coinbaseConnector],
  transports: Object.fromEntries(CHAIN_IDS.map((id) => [id, transportFor(id)])),
})
