// Single source of truth for chain-specific settings. This build targets a local anvil node
// (chain 31337) running the Swapex V4 contracts deployed by `contracts/script/Deploy.s.sol`.
export const REQUIRED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337)

export const CHAINS = {
  31337: { name: 'Anvil', explorer: null, hexId: '0x7a69', rpc: 'http://127.0.0.1:8545' },
  11155111: { name: 'Sepolia', explorer: 'https://sepolia.etherscan.io', hexId: '0xaa36a7' },
  1: { name: 'Ethereum', explorer: 'https://etherscan.io', hexId: '0x1' },
}

export const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%
export const DEFAULT_DEADLINE_MINUTES = 20 // tx deadline, enforced on-chain by the Router since B.1
export const MAX_SLIPPAGE_BPS = 5000 // hard cap 50%
export const HIGH_SLIPPAGE_BPS = 500 // warn above 5%
export const LOW_SLIPPAGE_BPS = 5 // warn below 0.05% (likely to fail)
export const HIGH_PRICE_IMPACT = 0.05 // warn above 5%

export function explorerTxUrl(chainId, hash) {
  const chain = CHAINS[chainId] || CHAINS[REQUIRED_CHAIN_ID]
  if (!chain || !chain.explorer) return null
  return `${chain.explorer}/tx/${hash}`
}
