// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwapexFactory} from "../../src/v3/SwapexFactory.sol";
import {SwapexPool} from "../../src/v3/SwapexPool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {FeeOnTransferToken} from "../mocks/FeeOnTransferToken.sol";
import {NoReturnToken} from "../mocks/NoReturnToken.sol";
import {RevertingToken} from "../mocks/RevertingToken.sol";
import {ReentrantToken} from "../mocks/ReentrantToken.sol";
import {ISwapexMintCallback, ISwapexSwapCallback, ISwapexFlashCallback} from "../../src/interfaces/ICallbacks.sol";

/// Fork-free tests proving the pool's behaviour against unusual ERC-20 implementations.
/// The pool must either work correctly or fail loudly — never silently mis-account.
///
/// Shared setup: deploy a factory, sort a token pair by address, deploy + initialise a pool.
/// Callbacks pay the pool by calling `transfer` on whichever side owes a positive amount,
/// using a low-level call so the same code works for tokens that return bool and those that don't.
abstract contract QuirksBase is Test, ISwapexMintCallback, ISwapexSwapCallback, ISwapexFlashCallback {
    uint160 internal constant Q96 = uint160(1 << 96);
    uint24 internal constant FEE = 3000;

    SwapexFactory internal factory;
    address internal token0; // lower address
    address internal token1; // higher address

    function setUp() public virtual {
        factory = new SwapexFactory(address(this));
    }

    function _sortAndSet(address a, address b) internal {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function _deployPool() internal returns (SwapexPool pool) {
        pool = SwapexPool(factory.createPool(token0, token1, FEE));
        pool.initialize(Q96); // price 1.0, tick 0
    }

    // ---- callbacks ----
    function swapexMintCallback(uint256 a0, uint256 a1, bytes calldata) external {
        _pay(msg.sender, a0, a1);
    }

    function swapexSwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _pay(msg.sender, a0 > 0 ? uint256(a0) : 0, a1 > 0 ? uint256(a1) : 0);
    }

    function swapexFlashCallback(uint256 fee0, uint256 fee1, bytes calldata) external {
        // repay principal (still in our balance) + fee
        _pay(msg.sender, fee0, fee1);
    }

    function _pay(address to, uint256 a0, uint256 a1) internal {
        if (a0 > 0) _transfer(token0, to, a0);
        if (a1 > 0) _transfer(token1, to, a1);
    }

    function _transfer(address token, address to, uint256 amt) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amt));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "pay failed");
    }

    function _limit(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? uint160(uint256(Q96) * 9 / 10) : uint160(uint256(Q96) * 11 / 10);
    }
}

// ---------------------------------------------------------------- fee-on-transfer
contract FeeOnTransferTest is QuirksBase {
    FeeOnTransferToken internal fot;
    MockERC20 internal good;

    function setUp() public override {
        super.setUp();
        fot = new FeeOnTransferToken("FOT", "FOT", 18, 0); // fee starts off for setup
        good = new MockERC20("GOOD", "GOOD", 18);
        _sortAndSet(address(fot), address(good));
    }

    function test_feeOnTransfer_mintRevertsInsufficientPayment() public {
        fot.setFeeBps(100); // 1%
        SwapexPool pool = _deployPool();
        fot.mint(address(this), 1e24);
        good.mint(address(this), 1e24);

        // In-range mint pulls both tokens. FOT skims on the way in, so the pool
        // receives less FOT than it credits the position → must revert, not under-credit.
        vm.expectRevert(SwapexPool.InsufficientPayment.selector);
        pool.mint(address(this), -120, 120, 1e18, "");
    }

    function test_feeOnTransfer_swapInputRevertsInsufficientPayment() public {
        // Seed active liquidity with the fee off, then turn it on to attack the swap path.
        SwapexPool pool = _deployPool();
        fot.mint(address(this), 1e24);
        good.mint(address(this), 1e24);
        pool.mint(address(this), -120, 120, 1e21, "");
        fot.setFeeBps(100);

        // Swap that spends FOT as input: callback under-pays, pool must reject.
        bool fotIsToken0 = token0 == address(fot);
        vm.expectRevert(SwapexPool.InsufficientPayment.selector);
        pool.swap(address(this), fotIsToken0, int256(1e18), _limit(fotIsToken0), "");
    }
}

// ---------------------------------------------------------------- no-return-value (USDT-style)
contract NoReturnTokenTest is QuirksBase {
    NoReturnToken internal noRet;
    MockERC20 internal normal;

    function setUp() public override {
        super.setUp();
        noRet = new NoReturnToken("NORET", "NORET", 18);
        normal = new MockERC20("NORMAL", "NORMAL", 18);
        _sortAndSet(address(noRet), address(normal));
    }

    function test_noReturnToken_fullLifecycleWorks() public {
        SwapexPool pool = _deployPool();
        noRet.mint(address(this), 1e24);
        normal.mint(address(this), 1e24);

        // mint (both sides), swap both directions, burn, collect — all must succeed.
        (uint256 a0, uint256 a1) = pool.mint(address(this), -120, 120, 1e20, "");
        assertGt(a0 + a1, 0);

        pool.swap(address(this), true, int256(1e18), _limit(true), "");
        pool.swap(address(this), false, int256(1e18), _limit(false), "");

        (uint256 p0, uint256 p1) = pool.burn(-120, 120, 1e20);
        (uint128 c0, uint128 c1) =
            pool.collect(address(this), -120, 120, type(uint128).max, type(uint128).max);
        assertGe(uint256(c0), p0);
        assertGe(uint256(c1), p1);
        assertEq(pool.liquidity(), 0);
    }
}

// ---------------------------------------------------------------- reverting transfer
contract RevertingTokenTest is QuirksBase {
    RevertingToken internal bad;
    MockERC20 internal good;

    function setUp() public override {
        super.setUp();
        bad = new RevertingToken("BAD", "BAD", 18);
        good = new MockERC20("GOOD", "GOOD", 18);
        _sortAndSet(address(bad), address(good));
    }

    function test_revertingToken_swapPayoutRevertsTokenTransferFailed() public {
        // Seed active in-range liquidity while transfers still work.
        bad.setReverting(false);
        SwapexPool pool = _deployPool();
        bad.mint(address(this), 1e24);
        good.mint(address(this), 1e24);
        pool.mint(address(this), -120, 120, 1e21, "");

        // Now make the bad token revert. A swap whose output is the bad token must
        // surface a clean TokenTransferFailed from the pool's _safeTransfer.
        bad.setReverting(true);
        bool badIsToken0 = token0 == address(bad);
        // swap in the direction that PAYS OUT the bad token (output = bad)
        // zeroForOne=true pays out token1; zeroForOne=false pays out token0.
        bool zeroForOne = !badIsToken0; // if bad is token0, we want output token0 → zeroForOne=false
        vm.expectRevert(SwapexPool.TokenTransferFailed.selector);
        pool.swap(address(this), zeroForOne, int256(1e18), _limit(zeroForOne), "");
    }
}

// ---------------------------------------------------------------- reentrant token
contract ReentrantTokenTest is QuirksBase {
    ReentrantToken internal reent;
    MockERC20 internal normal;

    function setUp() public override {
        super.setUp();
        reent = new ReentrantToken("REENT", "REENT", 18);
        normal = new MockERC20("NORMAL", "NORMAL", 18);
        _sortAndSet(address(reent), address(normal));
    }

    function test_reentrantToken_noReentrySucceeds() public {
        SwapexPool pool = _deployPool();
        reent.setPool(pool);
        reent.mint(address(this), 1e24);
        normal.mint(address(this), 1e24);

        // Mint pulls the reentrant token; during that transfer the token tries to
        // re-enter swap/collect. The pool lock must reject every attempt.
        pool.mint(address(this), -120, 120, 1e20, "");
        assertEq(reent.reentrySuccesses(), 0, "a reentrant call succeeded during mint");
        assertGt(reent.reentryAttempts(), 0, "token never attempted reentry");

        // Swap in both directions: payout transfers also trigger reentry attempts.
        pool.swap(address(this), true, int256(1e18), _limit(true), "");
        pool.swap(address(this), false, int256(1e18), _limit(false), "");
        assertEq(reent.reentrySuccesses(), 0, "a reentrant call succeeded during swap");

        // Accounting stayed intact: we can still burn and collect everything.
        pool.burn(-120, 120, 1e20);
        pool.collect(address(this), -120, 120, type(uint128).max, type(uint128).max);
        assertEq(pool.liquidity(), 0);
    }
}
