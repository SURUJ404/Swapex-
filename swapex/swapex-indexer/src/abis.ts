// Event fragments for the Swapex contracts, hand-written from the Solidity sources
// (swapex-contracts/src). viem matches logs by topic hash, so the two different
// Collect signatures (pool vs position manager) cannot collide.

export const FACTORY_EVENTS = [
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
] as const

export const POOL_EVENTS = [
  'event Initialize(uint160 sqrtPriceX96, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
] as const

export const POSITION_MANAGER_EVENTS = [
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
] as const

export const LIMIT_ORDER_EVENTS = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed filler, address tokenIn, address tokenOut, uint256 amountInFilled, uint256 amountOutPaid)',
  'event OrderCancelled(address indexed maker, uint256 nonce)',
] as const

export const ALL_EVENTS = [...FACTORY_EVENTS, ...POOL_EVENTS, ...POSITION_MANAGER_EVENTS, ...LIMIT_ORDER_EVENTS]
