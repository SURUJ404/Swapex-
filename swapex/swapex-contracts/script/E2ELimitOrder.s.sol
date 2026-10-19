// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SwapexLimitOrders} from "../src/periphery/SwapexLimitOrders.sol";
import {SwapexQuoter} from "../src/periphery/SwapexQuoter.sol";
import {IERC20Minimal} from "../src/interfaces/IERC20Minimal.sol";

/// Local end-to-end for limit orders: sign an EIP-712 order with anvil dev key #0 (the maker),
/// then fill it in two chunks from anvil dev key #1 (the keeper) and assert the balances.
///
///   forge script script/E2ELimitOrder.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Runs against deployments/31337.json + deployments/31337.seed.json (so run e2e-local.sh's
/// deploy + seed first). Refuses any other chain id; the anvil development keys below are
/// public and must never be used outside a local node.
contract E2ELimitOrder is Script {
    using stdJson for string;

    error NotLocalChain(uint256 chainId);

    uint256 internal constant MAKER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant FILLER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint24 internal constant FEE = 3000;
    uint256 internal constant AMOUNT_IN = 10e6; // ~$10: comfortably inside the seeded pool

    struct Ctx {
        SwapexLimitOrders limit;
        address tUsdc;
        address weth;
        address maker;
        address filler;
        uint256 quote;
        uint256 minAmountOut;
        uint256 makerBefore;
        uint256 receiverBefore;
        SwapexLimitOrders.Order order;
        bytes signature;
    }

    function run() external {
        if (block.chainid != 31337) revert NotLocalChain(block.chainid);

        Ctx memory c = _prepare();
        (uint256 paid1, uint256 paid2) = _fillTwice(c);
        _verify(c, paid1, paid2);

        console2.log("limit order round trip OK");
        console2.log("filled (raw tUSDC 6dp)", c.order.amountIn);
        console2.log("received (raw weth 18dp)", paid1 + paid2);
        console2.log("quoter quote", c.quote);
    }

    /// read the manifests, approve, quote, build and sign the order
    function _prepare() internal returns (Ctx memory c) {
        string memory manifest = vm.readFile("deployments/31337.json");
        c.limit = SwapexLimitOrders(manifest.readAddress(".limitOrders"));
        c.weth = manifest.readAddress(".weth9");
        address quoter = manifest.readAddress(".quoter");
        c.tUsdc = vm.readFile("deployments/31337.seed.json").readAddress(".tokens[0].address");
        c.maker = vm.addr(MAKER_KEY);
        c.filler = vm.addr(FILLER_KEY);

        // maker approves the order contract; the keeper is just anyone with gas
        vm.startBroadcast(MAKER_KEY);
        (bool ok,) = c.tUsdc.call(abi.encodeWithSignature("approve(address,uint256)", address(c.limit), type(uint256).max));
        require(ok, "approve failed");
        vm.stopBroadcast();

        // a realistic ask: the quoter's price minus a 0.1% buffer (see docs/DECISIONS.md)
        uint256 quote = SwapexQuoter(quoter)
            .quoteExactInputSingle(SwapexQuoter.QuoteSingleParams({tokenIn: c.tUsdc, tokenOut: c.weth, fee: FEE, amount: AMOUNT_IN, sqrtPriceLimitX96: 0}))
            .amount;
        c.quote = quote;
        c.minAmountOut = quote - quote / 1000;

        c.order = SwapexLimitOrders.Order({
            maker: c.maker,
            tokenIn: c.tUsdc,
            tokenOut: c.weth,
            amountIn: AMOUNT_IN,
            minAmountOut: c.minAmountOut,
            expiry: block.timestamp + 1 days,
            nonce: 0,
            receiver: c.filler
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_KEY, c.limit.orderHash(c.order));
        c.signature = abi.encodePacked(r, s, v);

        c.makerBefore = IERC20Minimal(c.tUsdc).balanceOf(c.maker);
        c.receiverBefore = IERC20Minimal(c.weth).balanceOf(c.filler);
    }

    /// keeper fills 60% now, then the remainder in a second chunk
    function _fillTwice(Ctx memory c) internal returns (uint256 paid1, uint256 paid2) {
        vm.startBroadcast(FILLER_KEY);
        (uint256 filled1, uint256 p1) = limit_fill(c, 6e6);
        vm.stopBroadcast();
        require(filled1 == 6e6, "fill1 amount wrong");
        require(p1 > 0, "fill1 paid nothing");
        paid1 = p1;

        vm.startBroadcast(FILLER_KEY);
        (uint256 filled2, uint256 p2) = limit_fill(c, type(uint256).max);
        vm.stopBroadcast();
        require(filled2 == 4e6, "fill2 amount wrong");
        require(p2 > 0, "fill2 paid nothing");
        paid2 = p2;
    }

    function limit_fill(Ctx memory c, uint256 cap) internal returns (uint256, uint256) {
        return c.limit.fill(
            SwapexLimitOrders.FillParams({
                order: c.order,
                amountInMax: cap,
                minAmountOut: 0,
                fee: FEE,
                deadline: block.timestamp + 1 hours,
                signature: c.signature
            })
        );
    }

    /// state, balances and the maker's floor must all line up
    function _verify(Ctx memory c, uint256 paid1, uint256 paid2) internal view {
        bytes32 digest = c.limit.orderHash(c.order);
        (uint256 stateFilled, uint256 stateOut) = c.limit.orders(digest);
        require(stateFilled == c.order.amountIn, "order not fully filled");
        require(stateOut == paid1 + paid2, "state out != sum of fills");
        require(stateOut >= c.minAmountOut, "maker floor missed");
        require(c.makerBefore - IERC20Minimal(c.tUsdc).balanceOf(c.maker) == c.order.amountIn, "maker input wrong");
        require(IERC20Minimal(c.weth).balanceOf(c.filler) - c.receiverBefore == stateOut, "receiver output wrong");
        require(IERC20Minimal(c.tUsdc).balanceOf(address(c.limit)) == 0, "limit contract holds input");
        require(IERC20Minimal(c.weth).balanceOf(address(c.limit)) == 0, "limit contract holds output");

        (bool can,) = c.limit.canFill(c.order);
        require(!can, "order still fillable");
        require(c.limit.remainingIn(c.order) == 0, "remaining != 0");
    }
}
