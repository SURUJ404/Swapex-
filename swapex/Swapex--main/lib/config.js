// Single source of truth for chain-specific settings.
//
// SAFETY DEFAULTS
// - The default chain is Sepolia (a testnet).
// - Mainnet is refused unless NEXT_PUBLIC_ALLOW_MAINNET=true, so a misconfigured deploy cannot
//   quietly send real funds through this (unaudited) app.
// - Contract addresses come from lib/deployments/<chainId>.json (written by the contracts repo).
//   Until Swapex's contracts are deployed to a chain, that chain is reported as "not deployed"
//   and every action button is disabled.
import { getDeployment } from './deployments'

export const ALLOW_MAINNET = process.env.NEXT_PUBLIC_ALLOW_MAINNET === 'true'
export const REQUIRED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 11155111)

export const CHAINS = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io', hexId: '0x1', testnet: false, rpc: 'https://cloudflare-eth.com' },
  11155111: { name: 'Sepolia', explorer: 'https://sepolia.etherscan.io', hexId: '0xaa36a7', testnet: true, rpc: 'https://rpc.sepolia.org' },
  84532: { name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org', hexId: '0x14a34', testnet: true, rpc: 'https://sepolia.base.org' },
  421614: { name: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io', hexId: '0x66eee', testnet: true, rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  31337: { name: 'Local (anvil)', explorer: '', hexId: '0x7a69', testnet: true, rpc: 'http://127.0.0.1:8545' },
}

export const IS_TESTNET = Boolean(CHAINS[REQUIRED_CHAIN_ID]?.testnet)

/** Swapex contract addresses for the required chain, or null when not deployed there. */
export const DEPLOYMENT = getDeployment(REQUIRED_CHAIN_ID)

/** A human-readable reason the app must not transact, or null when it is safe to proceed. */
export const CONFIG_ERROR = (() => {
  if (!CHAINS[REQUIRED_CHAIN_ID]) {
    return `Unsupported chain id ${REQUIRED_CHAIN_ID}. Set NEXT_PUBLIC_CHAIN_ID to a supported network.`
  }
  if (!IS_TESTNET && !ALLOW_MAINNET) {
    return 'Mainnet is disabled in this build. Swapex is testnet-only until it has been audited.'
  }
  if (!DEPLOYMENT) {
    return `Swapex contracts are not deployed on ${CHAINS[REQUIRED_CHAIN_ID].name} yet.`
  }
  return null
})()

export const WETH_ADDRESS = DEPLOYMENT ? DEPLOYMENT.weth9 : null

// Pool fee tiers (hundredths of a basis point) the app searches when it looks for the best route.
export const FEE_TIERS = [500, 3000, 10000]

export const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%
export const DEFAULT_DEADLINE_MINUTES = 20
export const MAX_SLIPPAGE_BPS = 5000 // hard cap 50%
export const HIGH_SLIPPAGE_BPS = 500 // warn above 5%
export const LOW_SLIPPAGE_BPS = 5 // warn below 0.05% (likely to fail)
export const HIGH_PRICE_IMPACT = 0.05 // warn above 5%

export function explorerTxUrl(chainId, hash) {
  const base = (CHAINS[chainId] || CHAINS[REQUIRED_CHAIN_ID]).explorer
  return base ? `${base}/tx/${hash}` : null
}
