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
  process.env.NEXT_PUBLIC_POOL_MANAGER || '0xC9a43158891282A2B1475592D5719c001986Aaec'
export const ALLOWANCE_TRANSFER_ADDRESS =
  process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0x1c85638e118b37167e9298c2268758e058DdfDA0'
export const ROUTER_ADDRESS =
  process.env.NEXT_PUBLIC_ROUTER || '0x367761085BF3C12e5DA2Df99AC6E1a824612b8fb'
export const QUOTER_ADDRESS =
  process.env.NEXT_PUBLIC_QUOTER || '0x4C2F7092C2aE51D986bEFEe378e50BD4dB99C901'

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
    address: process.env.NEXT_PUBLIC_SWA || '0x7A9Ec1d04904907De0ED7b6839CcdD59c3716AC9',
    decimals: 18,
    logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
  {
    symbol: 'SWB',
    name: 'Swapex B',
    address: process.env.NEXT_PUBLIC_SWB || '0x49fd2BE640DB2910c2fAb69bB8531Ab6E76127ff',
    decimals: 18,
    logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
  {
    symbol: 'SWC',
    name: 'Swapex C',
    address: process.env.NEXT_PUBLIC_SWC || '0x4631BCAbD6dF18D94796344963cB60d44a4136b6',
    decimals: 18,
    logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  },
]
