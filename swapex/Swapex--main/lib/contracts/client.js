// The only module in the app that constructs ethers.Contract.
// Adapters (erc20.js, factory.js, quoter.js, router.js, positionManager.js, events.js) call through here,
// so components and hooks never touch ABIs or contract addresses directly.
import { utils, Contract } from 'ethers'
import { DEPLOYMENT } from '../config'

import factoryAbi from '../abi/SwapexFactory.json'
import poolAbi from '../abi/SwapexPool.json'
import quoterAbi from '../abi/SwapexQuoter.json'
import routerAbi from '../abi/SwapexRouter.json'
import positionManagerAbi from '../abi/SwapexPositionManager.json'
import testTokenAbi from '../abi/TestToken.json'
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
  testToken: testTokenAbi,
  erc20: ERC20_ABI,
}

// core contracts whose address comes from the deployment manifest
const CORE_ADDRESSES = {
  factory: 'factory',
  router: 'router',
  quoter: 'quoter',
  positionManager: 'positionManager',
}

/** Drop duplicate fragments. Exported ABIs contain `InvalidPath` twice (once per inheritance
 *  branch) and ethers logs "duplicate definition" warnings for every Interface built from them. */
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
const INTERFACE_CACHE = new Map()

/** Cached deduped ABI array per adapter name. */
export function abiFor(name) {
  if (!DEDUPED_CACHE.has(name)) {
    const abi = ABIS[name]
    if (!abi) throw new Error(`Unknown contract ABI: ${name}`)
    DEDUPED_CACHE.set(name, dedupeAbi(abi))
  }
  return DEDUPED_CACHE.get(name)
}

/** Cached ethers Interface per adapter name, built from the deduped ABI. */
export function getInterface(name) {
  if (!INTERFACE_CACHE.has(name)) {
    INTERFACE_CACHE.set(name, new utils.Interface(abiFor(name)))
  }
  return INTERFACE_CACHE.get(name)
}

/** Address of a core contract on the connected deployment, or null when not deployed. */
export function deploymentAddress(name) {
  const key = CORE_ADDRESSES[name]
  if (!key) throw new Error(`Not a core contract: ${name}`)
  return DEPLOYMENT ? DEPLOYMENT[key] : null
}

/**
 * Construct a contract instance. `address` is required unless `name` is a core contract
 * (then the deployment manifest supplies it). `runner` is a provider (reads) or signer (writes).
 */
export function contractAt(name, runner, address) {
  const resolved = address || deploymentAddress(name)
  if (!resolved) throw new Error(`No address for contract: ${name}`)
  return new Contract(resolved, abiFor(name), runner)
}

/** Contract for an arbitrary address (pools, ERC-20s) using a known adapter ABI. */
export function contractFor(name, address, runner) {
  if (!address) throw new Error(`No address for contract: ${name}`)
  return new Contract(address, abiFor(name), runner)
}
