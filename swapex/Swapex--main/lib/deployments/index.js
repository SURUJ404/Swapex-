// Deployment manifests, one per chain, produced by swapex-contracts/scripts/export-abis.sh.
// A chain counts as "deployed" only when every core address is present. Nothing is hardcoded here.
import local from './31337.json'
import sepolia from './11155111.json'
import baseSepolia from './84532.json'
import arbitrumSepolia from './421614.json'

const MANIFESTS = {
  31337: local,
  11155111: sepolia,
  84532: baseSepolia,
  421614: arbitrumSepolia,
}

const CORE = ['weth9', 'factory', 'router', 'positionManager', 'quoter']
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function getDeployment(chainId) {
  const m = MANIFESTS[chainId]
  if (!m) return null
  if (!CORE.every((k) => typeof m[k] === 'string' && ADDRESS.test(m[k]))) return null
  return m
}
