import PoolManagerAbi from './abi/PoolManager.json'
import RouterAbi from './abi/Router.json'
import QuoterAbi from './abi/Quoter.json'
import Erc20Abi from './abi/ERC20.json'
import AllowanceTransferAbi from './abi/AllowanceTransfer.json'

// ---- V4 core (Swapex singleton + periphery). Defaults are the deterministic anvil addresses
// produced by `contracts/script/Deploy.s.sol`; override via env for any other deployment.
// NOTE: Deploy.s.sol deploys AllowanceTransfer between PoolManager and Router, so every address
// after PoolManager shifts whenever the script is re-run on a chain with existing nonces.
export const POOL_MANAGER_ADDRESS =
  process.env.NEXT_PUBLIC_POOL_MANAGER || '0x821f3361D454cc98b7555221A06Be563a7E2E0A6'
export const ALLOWANCE_TRANSFER_ADDRESS =
  process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0x1780bCf4103D3F501463AD3414c7f4b654bb7aFd'
export const ROUTER_ADDRESS =
  process.env.NEXT_PUBLIC_ROUTER || '0x5133BBdfCCa3Eb4F739D599ee4eC45cBCD0E16c5'
export const QUOTER_ADDRESS =
  process.env.NEXT_PUBLIC_QUOTER || '0x71089Ba41e478702e1904692385Be3972B2cBf9e'

export const POOL_MANAGER_ABI = PoolManagerAbi
export const ROUTER_ABI = RouterAbi
export const QUOTER_ABI = QuoterAbi
// bounded per-spender grants: the wallet grants this contract (not the Router) a one-time ERC-20
// allowance, then it grants the Router an amount-bounded, expiring spend out of it
export const ALLOWANCE_TRANSFER_ABI = AllowanceTransferAbi
// minimal ERC-20 surface used by the balance / allowance / approve hooks
export const ERC20_ABI = Erc20Abi

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
    logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
  {
    symbol: 'SWA',
    name: 'Swapex A',
    address: process.env.NEXT_PUBLIC_SWA || '0xC66AB83418C20A65C3f8e83B3d11c8C3a6097b6F',
    decimals: 18,
    logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
  {
    symbol: 'SWB',
    name: 'Swapex B',
    address: process.env.NEXT_PUBLIC_SWB || '0xeF31027350Be2c7439C1b0BE022d49421488b72C',
    decimals: 18,
    logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
  {
    symbol: 'SWC',
    name: 'Swapex C',
    address: process.env.NEXT_PUBLIC_SWC || '0x12Bcb546bC60fF39F1Adfc7cE4605d5Bd6a6A876',
    decimals: 18,
    logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
]
