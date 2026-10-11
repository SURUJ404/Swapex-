// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {Router} from "../../src/v4/periphery/Router.sol";
import {currency, ADDRESS_ZERO} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, amount0, amount1} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

contract RouterTest is Test {
    PoolManager pm;
    Router router;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;

    function setUp() public {
        pm = new PoolManager();
        router = new Router(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenC = new MockERC20("C", "C", 18);

        // the test contract acts as the user: fund it and approve the router for every token
        tokenA.mint(address(this), 1_000_000e18);
        tokenB.mint(address(this), 1_000_000e18);
        tokenC.mint(address(this), 1_000_000e18);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        tokenC.approve(address(router), type(uint256).max);
        vm.deal(address(this), 1_000_000e18);
    }

    receive() external payable {}

    function _key(address a, address b) internal pure returns (PoolKey memory) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    function _seed(PoolKey memory key) internal {
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e20}), address(this)
        );
    }

    function test_exactInputSingle_swapsAndMovesTokens() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        bool zeroForOne = currency.unwrap(key.currency0) == address(tokenA);
        uint256 aBefore = tokenA.balanceOf(address(this));
        uint256 bBefore = tokenB.balanceOf(address(this));

        router.exactInputSingle(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: 1e18,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            address(this)
        );

        assertLt(tokenA.balanceOf(address(this)), aBefore, "spent input tokenA");
        assertGt(tokenB.balanceOf(address(this)), bBefore, "received output tokenB");
    }

    function test_exactInput_multiHop_intermediateNetsToZero() public {
        PoolKey memory keyAB = _key(address(tokenA), address(tokenB));
        PoolKey memory keyBC = _key(address(tokenB), address(tokenC));
        router.initialize(keyAB, Q96);
        router.initialize(keyBC, Q96);
        _seed(keyAB);
        _seed(keyBC);

        PoolKey[] memory path = new PoolKey[](2);
        path[0] = keyAB;
        path[1] = keyBC;
        bool zeroForOneFirst = currency.unwrap(keyAB.currency0) == address(tokenA);

        uint256 aBefore = tokenA.balanceOf(address(this));
        uint256 bBefore = tokenB.balanceOf(address(this));
        uint256 cBefore = tokenC.balanceOf(address(this));

        router.exactInput(path, zeroForOneFirst, 1e18, address(this));

        assertLt(tokenA.balanceOf(address(this)), aBefore, "spent tokenA");
        assertGt(tokenC.balanceOf(address(this)), cBefore, "received tokenC");
        // the intermediate token never touched the user or the router's final balance
        assertEq(tokenB.balanceOf(address(this)), bBefore, "user tokenB unchanged");
        assertEq(tokenB.balanceOf(address(router)), 0, "router holds no intermediate tokenB");
    }

    function test_modifyLiquidity_addThenRemove_solvency() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);

        (BalanceDelta cdAdd,) = router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this)
        );
        assertLt(amount0(cdAdd), 0, "owes token0 on add");
        assertLt(amount1(cdAdd), 0, "owes token1 on add");
        uint256 deposited0 = uint256(-amount0(cdAdd));

        uint256 ethOrToken0Before = token0Balance(key);
        (BalanceDelta cdRem,) = router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -1e18}), address(this)
        );
        assertGt(amount0(cdRem), 0, "owed token0 on remove");
        uint256 returned0 = uint256(amount0(cdRem));

        // pool keeps a rounding surplus, so returned <= deposited
        assertLe(returned0, deposited0, "returned <= deposited");
        assertGt(token0Balance(key), ethOrToken0Before - 1, "token0 balance rose on remove");
    }

    function test_exactInputSingle_nativeInput() public {
        // pool (native, tokenB): native is address(0), the smallest, so it is currency0
        PoolKey memory key = PoolKey({
            currency0: ADDRESS_ZERO(),
            currency1: currency.wrap(address(tokenB)),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        router.initialize(key, Q96);
        // seed liquidity, providing native ETH (msg.value) + tokenB
        router.modifyLiquidity{value: 10_000e18}(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this)
        );

        uint256 bBefore = tokenB.balanceOf(address(this));
        // sell native (currency0) for tokenB; the router settles ETH from msg.value
        router.exactInputSingle{value: 1e18}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: 1e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1}),
            address(this)
        );
        assertGt(tokenB.balanceOf(address(this)), bBefore, "received tokenB for native input");
    }

    function token0Balance(PoolKey memory key) internal view returns (uint256) {
        return MockERC20(currency.unwrap(key.currency0)).balanceOf(address(this));
    }
}
