# Swapex contracts (from scratch)

Foundry project. Plan: **V3-style concentrated-liquidity pool first**, then a **V4-style PoolManager**
(`docs/V4_DESIGN.md`). All Solidity here is original code, not a fork.

## Status
- No Solidity compiler was available where this was written: **nothing has been compiled or run in Solidity yet.**
- The math and the pool logic were first implemented in Python (`reference/`) and checked there
  (accuracy, monotonicity, round trips, 512-bit mulDiv, swap-step properties, and 200 random multi-position
  scenarios that must stay solvent and fully redeemable). The Solidity mirrors those functions one-to-one,
  and `test/v3/GoldenVectors.t.sol` asserts the exact same integers the Python model produces.

## Layout
- `src/libraries/` FullMath, BitMath, SafeCast, LiquidityMath, TickMath, SqrtPriceMath, SwapMath, Tick, TickBitmap, Position
- `src/v3/` SwapexFactory (CREATE2 pools), SwapexPool (mint / burn / collect / swap / flash / protocol fee)
- `src/interfaces/` callbacks (`swapexMintCallback`, `swapexSwapCallback`, `swapexFlashCallback`)
- `reference/` Python reference model, self-checks, golden-vector generator
- `test/v3/` unit, fuzz and golden-vector tests

## First run

    curl -L https://foundry.paradigm.xyz | bash && foundryup
    forge install foundry-rs/forge-std --no-git     # or: git clone https://github.com/foundry-rs/forge-std lib/forge-std
    forge build
    forge test -vv

Python checks (no dependencies):

    cd reference && python3 check_refmath.py && python3 check_pool.py
    python3 gen_vectors.py          # regenerates test/v3/GoldenVectors.t.sol

## Design notes / known gaps
- `getTickAtSqrtRatio` is a 20-step binary search over `getSqrtRatioAtTick` (correct and simple, about 30k gas);
  replace with a log2 version later and keep the fuzz round-trip test as the oracle.
- Price precision at the extreme ends of the tick range is about 2^-64 relative (inherent to the Q128 reciprocal).
- No TWAP oracle yet, and no periphery (router, position NFT, quoter).
- Protocol fee: 1/N of swap fees (N in 4..10), set by the factory owner per pool.
- Before mainnet: external audit, formal checks of the swap invariant, bug bounty.


## Periphery

- `SwapexRouter`: exact-input and exact-output swaps over one or more pools, native ETH in and out, `multicall`, `selfPermit`.
- `SwapexQuoter`: exact quotes by running the real swap and reverting (call it with `eth_call`).
- `SwapexPositionManager`: liquidity positions as NFTs, with collect, increase, decrease and burn.
- `script/Deploy.s.sol`, `script/SeedTestnet.s.sol`, `scripts/e2e-local.sh`, `scripts/export-abis.sh`.
- The minimal ERC-721 in `src/periphery/ERC721Minimal.sol` should be replaced by a reviewed library before any real-value use.

- `scripts/e2e-positions.sh` exercises the position flows the web app uses (create + mint with ETH, remove to ETH, burn). Run it after `scripts/e2e-local.sh`.
