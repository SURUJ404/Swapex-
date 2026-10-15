import PoolManagerAbi from './abi/PoolManager.json'
import RouterAbi from './abi/Router.json'
import QuoterAbi from './abi/Quoter.json'
import Erc20Abi from './abi/ERC20.json'
import AllowanceTransferAbi from './abi/AllowanceTransfer.json'
import MerkleDistributorAbi from './abi/MerkleDistributor.json'

// ---- V4 core (Swapex singleton + periphery). Defaults are the deterministic anvil addresses
// produced by `contracts/script/Deploy.s.sol`; override via env for any other deployment.
// NOTE: Deploy.s.sol first deploys the linked SwapLogic library (nonce 0), so every address shifts
// by one relative to a library-free deployment, and again whenever the script is re-run on a chain
// with existing nonces. Override via NEXT_PUBLIC_* for any other deployment.
export const POOL_MANAGER_ADDRESS =
  process.env.NEXT_PUBLIC_POOL_MANAGER || '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
export const ALLOWANCE_TRANSFER_ADDRESS =
  process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9'
export const ROUTER_ADDRESS =
  process.env.NEXT_PUBLIC_ROUTER || '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9'
export const QUOTER_ADDRESS =
  process.env.NEXT_PUBLIC_QUOTER || '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
// C: the allowlist distributor (fixture root, timelock-owned root rotation)
export const MERKLE_DISTRIBUTOR_ADDRESS =
  process.env.NEXT_PUBLIC_MERKLE_DISTRIBUTOR || '0x67d269191c92Caf3cD7723F116c85e6E9bf55933'

export const POOL_MANAGER_ABI = PoolManagerAbi
export const ROUTER_ABI = RouterAbi
export const QUOTER_ABI = QuoterAbi
// bounded per-spender grants: the wallet grants this contract (not the Router) a one-time ERC-20
// allowance, then it grants the Router an amount-bounded, expiring spend out of it
export const ALLOWANCE_TRANSFER_ABI = AllowanceTransferAbi
// minimal ERC-20 surface used by the balance / allowance / approve hooks
export const ERC20_ABI = Erc20Abi
// Merkle allowlist claims (D35): claim/isClaimed/leafOf/merkleRoot + RootUpdated/Claimed events
export const MERKLE_DISTRIBUTOR_ABI = MerkleDistributorAbi

// ---- Pool identity defaults. Every Swapex pool in this demo uses a single fee tier, tick
// spacing, and no hooks; the frontend always builds keys with these unless overridden.
export const POOL_FEE = 3000
export const POOL_TICK_SPACING = 60
export const POOL_HOOKS = '0x0000000000000000000000000000000000000000'

// TickMath.getSqrtRatioAtTick(MIN_TICK) and (MAX_TICK) — the strict bounds the manager enforces
// on a swap's price limit. A limit one inside these bounds is the "no limit" default.
export const MIN_SQRT_RATIO = '4295128739'
export const MAX_SQRT_RATIO =
  '1461446703485210103287273052203988822378723970342'

// ---- Token list: native ETH + the three 18-decimal demo tokens deployed by Deploy.s.sol.
// Native is represented by the sentinel address 'NATIVE' and maps to currency0 = address(0).
export const NATIVE_ADDRESS = 'NATIVE'
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export const TOKEN_LIST = [
  {
    symbol: 'ETH',
    name: 'Ether',
    address: NATIVE_ADDRESS,
    decimals: 18,
    logo: '/tokens/token-logo.c253d7c5.png',
  },
  {
    symbol: 'SWA',
    name: 'Swapex A',
    address: process.env.NEXT_PUBLIC_SWA || '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
    decimals: 18,
    logo: '/tokens/token-logo.c253d7c5.png',
  },
  {
    symbol: 'SWB',
    name: 'Swapex B',
    address: process.env.NEXT_PUBLIC_SWB || '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
    decimals: 18,
    logo: '/tokens/token-logo.c253d7c5.png',
  },
  {
    symbol: 'SWC',
    name: 'Swapex C',
    address: process.env.NEXT_PUBLIC_SWC || '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
    decimals: 18,
    logo: '/tokens/token-logo.c253d7c5.png',
  },
]
