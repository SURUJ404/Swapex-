// Single source of truth for chain-specific settings.
// The router/factory addresses in constants/index.js are Ethereum mainnet,
// so the app requires that chain unless NEXT_PUBLIC_CHAIN_ID is overridden
// together with matching addresses.
export const REQUIRED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 1)

export const CHAINS = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io', hexId: '0x1' },
  11155111: { name: 'Sepolia', explorer: 'https://sepolia.etherscan.io', hexId: '0xaa36a7' },
}

export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

export const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%
export const DEFAULT_DEADLINE_MINUTES = 20
export const MAX_SLIPPAGE_BPS = 5000 // hard cap 50%
export const HIGH_SLIPPAGE_BPS = 500 // warn above 5%
export const LOW_SLIPPAGE_BPS = 5 // warn below 0.05% (likely to fail)
export const HIGH_PRICE_IMPACT = 0.05 // warn above 5%

export function explorerTxUrl(chainId, hash) {
  const base = (CHAINS[chainId] || CHAINS[1]).explorer
  return `${base}/tx/${hash}`
}
