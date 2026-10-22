// The only module in the app that imports contract ABIs.
// Adapters (erc20.js, factory.js, quoter.js, router.js, positionManager.js, events.js) call through here,
// so components and hooks never touch ABIs or contract addresses directly.
import { DEPLOYMENT } from '../config'

import factoryAbi from '../abi/SwapexFactory.json'
import poolAbi from '../abi/SwapexPool.json'
import quoterAbi from '../abi/SwapexQuoter.json'
import routerAbi from '../abi/SwapexRouter.json'
import positionManagerAbi from '../abi/SwapexPositionManager.json'
import limitOrdersAbi from '../abi/SwapexLimitOrders.json'
import { ERC20_ABI } from '../../constants'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
// sentinel the Swapex routers understand as "keep the balance in the contract" (unwrap/sweep later)
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'

const ABIS = {
  factory: factoryAbi,
  pool: poolAbi,
  quoter: quoterAbi,
  router: routerAbi,
  positionManager: positionManagerAbi,
  limitOrders: limitOrdersAbi,
  erc20: ERC20_ABI,
}

// core contracts whose address comes from the deployment manifest
const CORE_ADDRESSES = {
  factory: 'factory',
  router: 'router',
  quoter: 'quoter',
  positionManager: 'positionManager',
  limitOrders: 'limitOrders',
}

/** Drop duplicate fragments. Exported ABIs contain `InvalidPath` twice (once per inheritance
 *  branch) and viem's encode/decode helpers reject ambiguous matches, so every ABI is deduped. */
export function dedupeAbi(abi) {
  const seen = new Set()
  return (Array.isArray(abi) ? abi : []).filter((frag) => {
    const inputs = Array.isArray(frag.inputs) ? frag.inputs.map((i) => i.type).join(',') : ''
    const key = `${frag.type}:${frag.name || ''}:${inputs}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const DEDUPED_CACHE = new Map()

/** Cached deduped ABI array per adapter name — pass straight to viem read/write/encode helpers. */
export function abiFor(name) {
  if (!DEDUPED_CACHE.has(name)) {
    const abi = ABIS[name]
    if (!abi) throw new Error(`Unknown contract ABI: ${name}`)
    DEDUPED_CACHE.set(name, dedupeAbi(abi))
  }
  return DEDUPED_CACHE.get(name)
}

/** Address of a core contract on the connected deployment, or null when not deployed. */
export function deploymentAddress(name) {
  const key = CORE_ADDRESSES[name]
  if (!key) throw new Error(`Not a core contract: ${name}`)
  return DEPLOYMENT ? DEPLOYMENT[key] : null
}

/** { address, abi } for a core contract — spread into a viem readContract/writeContract call. */
export function coreContract(name) {
  return { address: deploymentAddress(name), abi: abiFor(name) }
}

/** { address, abi } for an arbitrary address (pools, ERC-20s) using a known adapter ABI. */
export function contractFor(name, address) {
  if (!address) throw new Error(`No address for contract: ${name}`)
  return { address, abi: abiFor(name) }
}

/**
 * readContract that keeps output names for multi-output functions.
 * viem's decodeFunctionResult returns a plain array when a function has more than one
 * output — the ABI's output names are dropped (ethers' Result kept them). Attach them,
 * so adapters can read r.amountOut / s0.sqrtPriceX96 exactly as the ABI declares.
 * Single-output reads (including tuples, which viem already decodes to named objects)
 * are returned untouched.
 */
export async function readNamed(client, contract, functionName, args) {
  const result = await client.readContract({
    ...contract,
    functionName,
    ...(args !== undefined ? { args } : {}),
  })
  if (!Array.isArray(result)) return result
  const fn = contract.abi.find((e) => e.type === 'function' && e.name === functionName && (e.outputs?.length || 0) > 1)
  if (!fn) return result
  fn.outputs.forEach((o, i) => {
    if (o.name) result[o.name] = result[i]
  })
  return result
}
