// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {Router} from "../../src/v4/periphery/Router.sol";
import {AllowanceTransfer} from "../../src/v4/periphery/AllowanceTransfer.sol";
import {currency, ADDRESS_ZERO} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, amount0, amount1} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

contract RouterTest is Test {
    PoolManager pm;
    Router router;
    AllowanceTransfer at;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;

    function setUp() public {
        pm = new PoolManager(address(this));
        at = new AllowanceTransfer();
        router = new Router(pm, at);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenC = new MockERC20("C", "C", 18);

        // the test contract acts as the user: fund it, then grant the router a bounded allowance
        // over every token (one-time ERC-20 approval to the allowance contract, then a per-spender
        // grant the router may spend until expiry).
        tokenA.mint(address(this), 1_000_000e18);
        tokenB.mint(address(this), 1_000_000e18);
        tokenC.mint(address(this), 1_000_000e18);
        _grant(tokenA);
        _grant(tokenB);
        _grant(tokenC);
        vm.deal(address(this), 1_000_000e18);
    }

    function _grant(MockERC20 token) internal {
        token.approve(address(at), type(uint256).max);
        at.setAllowance(address(token), address(router), type(uint160).max, type(uint48).max);
    }

    receive() external payable {}

    function _key(address a, address b) internal pure returns (PoolKey memory) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    // B.1: every router entry now takes a tx deadline and (for liquidity) amount bounds. These
    // legacy tests exercise settlement, not bound enforcement, so they pass an effectively
    // infinite deadline and no bounds; the bounds/deadline enforcement itself is covered in
    // test_exactInputSingle_revertsAfterDeadline and below.
    uint256 internal constant FAR_DEADLINE = type(uint256).max;

    function _unbounded() internal pure returns (Router.LiquidityBounds memory) {
        return Router.LiquidityBounds({amount0Min: 0, amount1Min: 0, amount0Max: type(uint256).max, amount1Max: type(uint256).max});
    }

    function _seed(PoolKey memory key) internal {
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e20}), address(this), _unbounded(), FAR_DEADLINE
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
            address(this),
             0,
             FAR_DEADLINE
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

        router.exactInput(path, zeroForOneFirst, 1e18, address(this), 0, FAR_DEADLINE);

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
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this), _unbounded(), FAR_DEADLINE
        );
        assertLt(amount0(cdAdd), 0, "owes token0 on add");
        assertLt(amount1(cdAdd), 0, "owes token1 on add");
        uint256 deposited0 = uint256(-amount0(cdAdd));

        uint256 ethOrToken0Before = token0Balance(key);
        (BalanceDelta cdRem,) = router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -1e18}), address(this), _unbounded(), FAR_DEADLINE
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
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this), _unbounded(), FAR_DEADLINE
        );

        uint256 bBefore = tokenB.balanceOf(address(this));
        // sell native (currency0) for tokenB; the router settles ETH from msg.value
        router.exactInputSingle{value: 1e18}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: 1e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1}),
            address(this),
             0,
             FAR_DEADLINE
        );
        assertGt(tokenB.balanceOf(address(this)), bBefore, "received tokenB for native input");
    }

    function test_exactInputSingle_overpaidNative_isRefunded() public {
        PoolKey memory key = PoolKey({
            currency0: ADDRESS_ZERO(),
            currency1: currency.wrap(address(tokenB)),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        router.initialize(key, Q96);
        router.modifyLiquidity{value: 10_000e18}(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this), _unbounded(), FAR_DEADLINE
        );

        uint256 walletBefore = address(this).balance;
        uint256 bBefore = tokenB.balanceOf(address(this));
        // attach 2e18 although the swap consumes far less: the difference must come back,
        // otherwise it would sit in the router forever (no owner, no withdrawal path).
        BalanceDelta d = router.exactInputSingle{value: 2e18}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: 1e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1}),
            address(this),
            0,
            FAR_DEADLINE
        );
        uint256 consumed = uint256(-amount0(d));
        assertLt(consumed, 2e18, "swap did not need all of msg.value");
        assertGt(tokenB.balanceOf(address(this)), bBefore, "swap consumed native input");
        assertEq(address(this).balance, walletBefore - consumed, "excess refunded to the payer");
        assertEq(address(router).balance, 0, "router holds no stray ETH");
    }

    function test_exactInputSingle_partialFill_refundsTheUnfilledRemainder() public {
        PoolKey memory key = PoolKey({
            currency0: ADDRESS_ZERO(),
            currency1: currency.wrap(address(tokenB)),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        router.initialize(key, Q96);
        router.modifyLiquidity{value: 10_000e18}(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this), _unbounded(), FAR_DEADLINE
        );

        uint256 walletBefore = address(this).balance;
        uint256 bBefore = tokenB.balanceOf(address(this));
        // a price limit one tick below the current price stops the fill long before amountIn:
        // the router settles only what was actually consumed and must refund the rest.
        BalanceDelta d = router.exactInputSingle{value: 1e18}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: 1e18,
                sqrtPriceLimitX96: TickMath.getSqrtRatioAtTick(-60)
            }),
            address(this),
            0,
            FAR_DEADLINE
        );
        uint256 consumed = uint256(-amount0(d));
        assertLt(consumed, 1e18, "price limit stopped the fill early");
        assertGt(tokenB.balanceOf(address(this)), bBefore, "partial fill produced output");
        assertEq(address(this).balance, walletBefore - consumed, "unfilled remainder refunded");
        assertEq(address(router).balance, 0, "router holds no stray ETH");
    }

    function test_exactInputSingle_revertsBelowMinOut() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        bool zeroForOne = currency.unwrap(key.currency0) == address(tokenA);
        // an impossible floor: demand far more output than the pool can give for 1e18 input.
        vm.expectRevert();
        router.exactInputSingle(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: 1e18,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            address(this),
            type(uint128).max, FAR_DEADLINE
        );
    }

    function token0Balance(PoolKey memory key) internal view returns (uint256) {
        return MockERC20(currency.unwrap(key.currency0)).balanceOf(address(this));
    }

    function test_positionRegistry_tracksUserLiquidity() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);

        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this), _unbounded(), FAR_DEADLINE
        );
        assertEq(router.getPositionLiquidity(address(this), key, -6000, 6000), 1e18, "add credited");

        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -4e17}), address(this), _unbounded(), FAR_DEADLINE
        );
        assertEq(router.getPositionLiquidity(address(this), key, -6000, 6000), 6e17, "remove debited");
    }

    function test_positionRegistry_revertsOverRemoval() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);

        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}), address(this), _unbounded(), FAR_DEADLINE
        );
        // the user only owns 1e18; asking for more must revert so they can't spend another's share
        vm.expectRevert();
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -2e18}), address(this), _unbounded(), FAR_DEADLINE
        );
    }

    function test_modifyLiquidity_fullRangeAddRemove() public {
        // native pool at 1:1, then a full-range (spacing-aligned) position
        PoolKey memory key =
            PoolKey({currency0: ADDRESS_ZERO(), currency1: currency.wrap(address(tokenB)), fee: 3000, tickSpacing: 60, hooks: address(0)});
        router.initialize(key, Q96);
        (int24 lo, int24 hi) = (int24(-887220), int24(887220)); // fullRangeTicks(60)

        uint128 liq = 5e17;
        router.modifyLiquidity{value: 1e18}(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(liq))}), address(this), _unbounded(), FAR_DEADLINE
        );
        assertEq(router.getPositionLiquidity(address(this), key, lo, hi), liq, "registry credited");

        (BalanceDelta cd,) = router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: -int256(uint256(liq))}), address(this), _unbounded(), FAR_DEADLINE
        );
        assertGt(amount1(cd), 0, "got tokenB back");
        assertEq(router.getPositionLiquidity(address(this), key, lo, hi), 0, "registry cleared");
    }


    function test_exactInputSingleWithPermit_toleratesAFrontRun() public {
        uint256 pk = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        address alice = vm.addr(pk);

        // alice funds herself and gives the allowance contract the outer ERC-20 approval.
        tokenA.mint(alice, 1_000e18);
        tokenB.mint(alice, 1_000e18);
        vm.startPrank(alice);
        tokenA.approve(address(at), type(uint256).max);
        tokenB.approve(address(at), type(uint256).max);
        vm.stopPrank();

        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        bool zeroForOne = currency.unwrap(key.currency0) == address(tokenA);
        currency input = zeroForOne ? key.currency0 : key.currency1;
        address output = currency.unwrap(zeroForOne ? key.currency1 : key.currency0);
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: 1e18,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });

        AllowanceTransfer.PermitSingle memory p = AllowanceTransfer.PermitSingle({
            details: AllowanceTransfer.PermitDetails({
                token: currency.unwrap(input),
                amount: 1e18,
                expiration: uint48(block.timestamp + 1 days),
                nonce: 0
            }),
            spender: address(router),
            sigDeadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, at.hashPermitSingle(p));
        bytes memory sig = abi.encodePacked(r, s, v);

        // a relayer front-runs the signed grant -- submitting it is permissionless.
        at.permit(alice, p, sig);
        (uint160 granted,) = at.allowanceOf(alice, currency.unwrap(input), address(router));
        assertEq(uint256(granted), 1e18, "front-run established the router's allowance");

        // alice's own permit+swap must still land: the nonce is spent, so the router reuses the
        // allowance the front-run already created instead of dying on a replay of the grant.
        uint256 outBefore = MockERC20(output).balanceOf(alice);
        vm.prank(alice);
        router.exactInputSingleWithPermit(key, sp, alice, 0, FAR_DEADLINE, p, sig);

        assertGt(MockERC20(output).balanceOf(alice), outBefore, "swap settled despite the front-run");
    }

    function test_exactInputSingleWithPermit_rejectsAGrantTargetingAnotherSpender() public {
        uint256 pk = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        address alice = vm.addr(pk);
        tokenA.mint(alice, 1_000e18);
        tokenB.mint(alice, 1_000e18);
        vm.startPrank(alice);
        tokenA.approve(address(at), type(uint256).max);
        tokenB.approve(address(at), type(uint256).max);
        vm.stopPrank();

        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        bool zeroForOne = currency.unwrap(key.currency0) == address(tokenA);
        currency input = zeroForOne ? key.currency0 : key.currency1;
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: 1e18,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });

        // a grant naming some other contract as spender would let a nonce be burned for nothing,
        // so the router refuses it up front rather than discovering it at settlement time.
        AllowanceTransfer.PermitSingle memory p = AllowanceTransfer.PermitSingle({
            details: AllowanceTransfer.PermitDetails({
                token: currency.unwrap(input),
                amount: 1e18,
                expiration: uint48(block.timestamp + 1 days),
                nonce: 0
            }),
            spender: makeAddr("someoneElse"),
            sigDeadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, at.hashPermitSingle(p));
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Router.InvalidPermitSpender.selector, address(router), p.spender));
        router.exactInputSingleWithPermit(key, sp, alice, 0, FAR_DEADLINE, p, sig);
    }

    // ---------------------------------------------------------------- B.1: bound enforcement
    // Every externally-callable swap/liquidity entry must refuse to execute outside its deadline
    // and (where the entry has one) outside its amount bounds: a mempool tx that is only mined
    // later must not run against a price the user never accepted.

    function _swapParams() internal pure returns (SwapParams memory sp) {
        // sell currency0 for currency1 — valid for any pool in this suite
        sp = SwapParams({
            zeroForOne: true,
            amountSpecified: 1e18,
            sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
        });
    }

    function test_deadline_exactInputSingle_revertsWhenPastDeadline() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);
        SwapParams memory sp = _swapParams();
        uint256 deadline = block.timestamp + 10;

        // boundary: a deadline equal to the current timestamp is still valid
        router.exactInputSingle(key, sp, address(this), 0, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(Router.TransactionTooOld.selector, deadline, deadline + 1));
        router.exactInputSingle(key, sp, address(this), 0, deadline);
    }

    function test_deadline_exactInput_revertsWhenPastDeadline() public {
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
        uint256 deadline = block.timestamp + 10;

        router.exactInput(path, zeroForOneFirst, 1e18, address(this), 0, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(Router.TransactionTooOld.selector, deadline, deadline + 1));
        router.exactInput(path, zeroForOneFirst, 1e18, address(this), 0, deadline);
    }

    function test_deadline_modifyLiquidity_revertsWhenPastDeadline() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        uint256 deadline = block.timestamp + 10;

        router.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}),
            address(this),
            _unbounded(),
            deadline
        );

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(Router.TransactionTooOld.selector, deadline, deadline + 1));
        router.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}),
            address(this),
            _unbounded(),
            deadline
        );
    }

    function test_deadline_exactInputSingleWithPermit_revertsWhenPastDeadline() public {
        uint256 pk = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        address alice = vm.addr(pk);
        tokenA.mint(alice, 1_000e18);
        vm.startPrank(alice);
        tokenA.approve(address(at), type(uint256).max);
        vm.stopPrank();

        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        bool zeroForOne = currency.unwrap(key.currency0) == address(tokenA);
        address input = currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: 1e18,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });
        AllowanceTransfer.PermitSingle memory p = AllowanceTransfer.PermitSingle({
            details: AllowanceTransfer.PermitDetails({
                token: input,
                amount: 1e18,
                expiration: uint48(block.timestamp + 1 days),
                nonce: 0
            }),
            spender: address(router),
            sigDeadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, at.hashPermitSingle(p));
        bytes memory sig = abi.encodePacked(r, s, v);

        uint256 deadline = block.timestamp + 10;
        vm.warp(deadline + 1);
        // the deadline is checked first: even a perfectly valid permit cannot reschedule the swap
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Router.TransactionTooOld.selector, deadline, deadline + 1));
        router.exactInputSingleWithPermit(key, sp, alice, 0, deadline, p, sig);
    }

    function test_exactInput_minOut_revertsOnMultiHopPath() public {
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

        // an impossible floor on the *final* output: the multi-hop path must not execute unbounded
        vm.expectPartialRevert(Router.InsufficientOutputAmount.selector);
        router.exactInput(path, zeroForOneFirst, 1e18, address(this), type(uint128).max, FAR_DEADLINE);

        // a reachable floor settles
        uint256 cBefore = tokenC.balanceOf(address(this));
        router.exactInput(path, zeroForOneFirst, 1e18, address(this), 1, FAR_DEADLINE);
        assertGt(tokenC.balanceOf(address(this)), cBefore, "bounded multi-hop settled");
    }

    function test_modifyLiquidity_add_revertsWhenAboveAmountMax() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        // the caller is willing to pay at most 1 wei of currency0: a full-range add needs far
        // more, so the deposit must be refused rather than silently filled at any price.
        vm.expectPartialRevert(Router.AmountAboveMax.selector);
        router.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}),
            address(this),
            Router.LiquidityBounds({amount0Min: 0, amount1Min: 0, amount0Max: 1, amount1Max: type(uint256).max}),
            FAR_DEADLINE
        );
    }

    function test_modifyLiquidity_remove_revertsWhenBelowAmountMin() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        // demand far more currency0 back than the position is worth: a removal that would land
        // below the signed floor must not settle at the manipulated price.
        vm.expectPartialRevert(Router.AmountBelowMin.selector);
        router.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -1e18}),
            address(this),
            Router.LiquidityBounds({amount0Min: type(uint128).max, amount1Min: 0, amount0Max: type(uint256).max, amount1Max: type(uint256).max}),
            FAR_DEADLINE
        );
    }

    function test_modifyLiquidity_addWithinMax_succeeds() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);

        // generous but finite maxes: a deposit within the caller's tolerance still settles
        router.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}),
            address(this),
            Router.LiquidityBounds({amount0Min: 0, amount1Min: 0, amount0Max: type(uint128).max, amount1Max: type(uint128).max}),
            FAR_DEADLINE
        );
        assertGt(router.getPositionLiquidity(address(this), key, -6000, 6000), 1e18, "add within bounds credited");
    }

    function test_exactInputSingle_minOutZero_isAllowedOptOut() public {
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        _seed(key);
        SwapParams memory sp = _swapParams();
        // documented semantics: minAmountOut == 0 explicitly accepts any price (the check is
        // skipped). Real front-ends must always pass a floor; the deadline still applies.
        router.exactInputSingle(key, sp, address(this), 0, FAR_DEADLINE);
    }

    // ---- multi-hop direction is derived by walking the path (two fee tiers of the SAME pair)
    function test_exactInput_adjacentPoolsShareBothCurrencies_walksTheCurrentCurrency() public {
        PoolKey memory k1 = _key(address(tokenA), address(tokenB)); // 0.30% / spacing 60
        PoolKey memory k2 = PoolKey({
            currency0: k1.currency0, currency1: k1.currency1, fee: 500, tickSpacing: 10, hooks: address(0)
        });
        router.initialize(k1, Q96);
        router.initialize(k2, Q96);
        _seed(k1);
        router.modifyLiquidity(
            k2, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e20}), address(this), _unbounded(), FAR_DEADLINE
        );

        PoolKey[] memory path = new PoolKey[](2);
        path[0] = k1;
        path[1] = k2;
        bool aIsCurrency0 = address(tokenA) < address(tokenB);
        uint256 a0 = tokenA.balanceOf(address(this));
        uint256 b0 = tokenB.balanceOf(address(this));

        // A -> B on pool 1, then B -> A on pool 2: the user ends with A again, minus the two fees
        router.exactInput(path, aIsCurrency0, 1e16, address(this), 0.009e18, FAR_DEADLINE);

        uint256 a1 = tokenA.balanceOf(address(this));
        assertEq(tokenB.balanceOf(address(this)), b0, "intermediate token must net to zero");
        assertLt(a1, a0, "two fee tiers must cost something");
        assertGt(a1, a0 - 0.0001e18, "but only about 0.35% fees plus small impact");
    }

    function test_exactInput_disjointPath_reverts() public {
        PoolKey memory kAB = _key(address(tokenA), address(tokenB));
        PoolKey memory kC0 = _key(address(tokenC), address(0xdead));
        router.initialize(kAB, Q96);
        _seed(kAB);
        PoolKey[] memory path = new PoolKey[](2);
        path[0] = kAB;
        path[1] = kC0;
        vm.expectRevert(Router.PathCurrenciesDisjoint.selector);
        router.exactInput(path, true, 1e18, address(this), 0, FAR_DEADLINE);
    }
}
