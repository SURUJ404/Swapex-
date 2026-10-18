# Contract gaps

What the Swapex contracts do not provide today, how that limits the front end, and the
exact interface the front end would consume if the owner ever approves adding the missing
contracts. Derived from `ARCHITECTURE_AUDIT.md` §6; contracts remain read-only until the
owner asks for changes. All snippets are original sketches (no external code).

## 1. No limit-order contract

`/limit` ships as an honest disabled screen. Filling a limit order needs an escrow or
signature-based order book contract plus an indexer of open orders.

Front end would need:

```solidity
interface ISwapexLimitOrders {
    enum OrderStatus { Open, Filled, Cancelled, Expired }

    struct Order {
        address maker;
        address tokenIn;
        address tokenOut;
        uint24  fee;
        uint256 amountIn;      // remaining
        uint256 minAmountOut;  // limit price, slippage-adjusted at fill time
        uint64  expiry;
        bytes32 salt;
    }

    function postOrder(Order calldata order, bytes calldata signature) external;
    function cancelOrder(bytes32 orderId) external;
    function fillOrder(bytes32 orderId, uint256 amountInMax) external returns (uint256 amountOut);
    function getOrder(bytes32 orderId) external view returns (Order memory, OrderStatus);
}
```

Adapter note: fills must revert (not partial-fill) like the router, and the order id should
be `keccak(abi.encode(order))` so the UI can derive it without an indexer round-trip.

## 2. No Permit2

Approvals are plain ERC-20 `approve(positionManager|router, exactAmount)` (two txs: approve
then act). Optional EIP-2612 `selfPermit` is supported where the token has it. Permit2 would
collapse approve+swap into one signature.

Front end would need (router side):

```solidity
// on SwapexRouter
function selfPermit(
    address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s
) external;
function selfPermitIfNecessary(/* same args */) external;
```

and the Permit2 `PermitSingle` witness flow the UI signs:

```solidity
struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }
struct PermitSingle  { PermitDetails details; address spender; uint256 sigDeadline; }
// permitWitness(permitSingle, witnessTypeHash, witness, "PermitSingle", deadline, sig)
```

Testnet verdict: fine without it; two-tx approvals are honest and testable.

## 3. Quoter is non-view

`SwapexQuoter` reverts internally and returns the quote via revert data, so
`quoter.callStatic.quoteExactInput(...)` is required. A plain `.quoteExactInput(...)`
throws `CallException` and the UI would show a quote error for a working pool.

Adapter rule (already in force): every quoter call goes through `callStatic`, single and
multi-hop, in and out. Do not "fix" this by marking the contract `view` without review —
the revert-then-return shape is deliberate.

## 4. `Swap` event has no pool address in args

The pool's `Swap` event carries sender/recipient/amounts/sqrtPrice/liquidity/tick but not
the emitting pool's address. Indexers must take the pool from the log's `address` field:

```
log.address            -> pool
log.topics[1..2]       -> sender, recipient (indexed)
log.data               -> amount0, amount1, sqrtPriceX96, liquidity, tick
```

Front end impact: none directly (it reads pools via the factory), but any explore/activity
feature must key candles and volumes by `log.address`, never by an arg.

## 5. No TWAP / no TickLens

Pools store one cumulative-price observation slot and expose no `observations()` history,
and there is no per-tick liquidity lens contract.

Consequences the UI must not paper over:
- Pool detail charts can only use indexer-built candles from `Swap` events; there is no
  on-chain TWAP to display or quote against.
- The add-liquidity range histogram must stay client-side math (from `slot0` + current
  `liquidity` + fee tier tick spacing), or wait for a TickLens-style contract:

```solidity
interface ISwapexTickLens {
    struct PopulatedTick {
        int24  tick;
        uint128 liquidityNet;
        uint256 liquidityGross;
    }
    function getPopulatedTicks(address pool) external view returns (PopulatedTick[] memory);
}
```

## 6. `ERC721Minimal` is hand-rolled and unaudited

`src/periphery/ERC721Minimal.sol` implements just enough ERC-721 for the position NFT.
It has not been reviewed against the EIP-721 conformance suite. Acceptable for
testnet-only; **must be replaced by a reviewed library before any real-value use**
(AGENTS.md known fact). Front end impact today: none — `ownerOf`, `safeTransferFrom`,
`approve` behave normally in tests. No UI change; this is a contracts-side gate.

## 7. Factory fee tiers are fixed

`SwapexFactory` enables exactly 500 / 3000 / 10000 (hundredths of a bp). The UI mirrors
them in `lib/config.js` `FEE_TIERS`. If the factory ever gains `enableFeeTier`, the config
should switch to reading `factory.FEE_TIER_AMOUNTS` at runtime instead of the constant.

## Summary matrix

| Gap | Blocks | Status |
|---|---|---|
| Limit orders | `/limit` real mode | disabled screen, by design |
| Permit2 | 1-tx approve+swap | two-tx approvals, fine for testnet |
| Quoter non-view | nothing (handled) | `callStatic` in adapter |
| Swap event shape | indexer design | take pool from `log.address` |
| TWAP / TickLens | on-chain charts, TWAP quotes | indexer candles only; client-side histogram |
| ERC721Minimal | real-value use | contracts-side replacement gate |
| Fixed fee tiers | dynamic tier discovery | keep `FEE_TIERS` in sync manually |
