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
import {Hooks} from "../../src/v4/libraries/Hooks.sol";

uint160 constant Q96_PF = uint160(1 << 96);

/// @dev hook mined with BEFORE_ADD_LIQUIDITY_FLAG that donates both sides of the pool right
///      before every add: the growth lands in the window between the Router's fee-growth read
///      and the manager's position update, which is exactly the window a pre-hardening
///      checkpoint failed to account for.
contract DonateOnAddHook {
    PoolManager public immutable pm;
    MockERC20 public immutable tokenA;
    MockERC20 public immutable tokenB;
    uint256 public immutable amount;

    constructor(PoolManager _pm, address _tokenA, address _tokenB, uint256 _amount) {
        pm = _pm;
        tokenA = MockERC20(_tokenA);
        tokenB = MockERC20(_tokenB);
        amount = _amount;
    }

    function beforeAddLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata) external {
        tokenA.approve(address(pm), amount);
        tokenB.approve(address(pm), amount);
        // with no liquidity in the pool there is nobody to accrue a donation to and the manager
        // reverts (NoLiquidityToAccrue) — the very first join simply proceeds undonated
        try pm.donate(key, amount, amount) {
            _settle(key.currency0);
            _settle(key.currency1);
        } catch {}
    }

    function _settle(currency c) private {
        if (pm.getCurrencyDelta(address(this), c) < 0) pm.settle(c);
    }
}

/// @notice D41 — the manager keys positions by whoever calls `modifyLiquidity`, so every LP in a
///         range merges into ONE on-chain slot. Settlement used to net the slot's whole
///         `feesAccrued` against each caller's principal, which let any LP who touched the slot
///         take fees they never earned (or pay less principal than they owed). These tests pin the
///         split: each caller moves their full principal, every fee the slot produced is booked to
///         the router's reserve, and each LP can only ever collect their own share of it.
contract PositionFeesTest is Test {
    PoolManager pm;
    Router router;
    AllowanceTransfer at;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address internal constant LP2 = address(uint160(0xBA11));

    uint256 internal constant FAR_DEADLINE = type(uint256).max;
    int24 internal constant LO = -6000;
    int24 internal constant HI = 6000;

    function setUp() public {
        pm = new PoolManager(address(this));
        at = new AllowanceTransfer();
        router = new Router(pm, at);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        _mintAndGrant(address(this));
        _grant(address(this));
        // the test contract also donates through its own unlock sessions (D41 window tests)
        tokenA.approve(address(pm), type(uint256).max);
        tokenB.approve(address(pm), type(uint256).max);
        tokenA.mint(LP2, 1_000_000e18);
        tokenB.mint(LP2, 1_000_000e18);
        _grant(LP2);
        vm.deal(address(this), 1_000_000e18);
        vm.deal(LP2, 1_000_000e18);
    }

    receive() external payable {}

    // ---------------------------------------------------------------- helpers

    function _mintAndGrant(address who) internal {
        tokenA.mint(who, 1_000_000e18);
        tokenB.mint(who, 1_000_000e18);
    }

    function _grant(address who) internal {
        vm.startPrank(who);
        tokenA.approve(address(at), type(uint256).max);
        tokenB.approve(address(at), type(uint256).max);
        at.setAllowance(address(tokenA), address(router), type(uint160).max, type(uint48).max);
        at.setAllowance(address(tokenB), address(router), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _key() internal view returns (PoolKey memory) {
        (address lo, address hi) = address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    function _unbounded() internal pure returns (Router.LiquidityBounds memory) {
        return Router.LiquidityBounds({amount0Min: 0, amount1Min: 0, amount0Max: type(uint256).max, amount1Max: type(uint256).max});
    }

    function _add(address who, int256 liq, uint256 value) internal returns (BalanceDelta cd) {
        PoolKey memory key = _key();
        vm.prank(who);
        (cd,) = router.modifyLiquidity{value: value}(
            key, ModifyLiquidityParams({tickLower: LO, tickUpper: HI, liquidityDelta: liq}), who, _unbounded(), FAR_DEADLINE
        );
    }

    function _remove(address who, int256 liq) internal returns (BalanceDelta cd, BalanceDelta fees) {
        PoolKey memory key = _key();
        vm.prank(who);
        (cd, fees) = router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: LO, tickUpper: HI, liquidityDelta: liq}), who, _unbounded(), FAR_DEADLINE
        );
    }

    /// @dev which half of a `BalanceDelta` belongs to `token`, regardless of sort order.
    function _side(PoolKey memory key, BalanceDelta d, address token) internal pure returns (int256) {
        return currency.unwrap(key.currency0) == token ? amount0(d) : amount1(d);
    }

    function _swap(bool zeroForOne, uint256 amount) internal {
        PoolKey memory key = _key();
        router.exactInputSingle(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            address(this),
            0,
            FAR_DEADLINE
        );
    }

    /// @dev what the router would pay `who` right now if they collected.
    function _unclaimed(address who) internal view returns (uint256 u0, uint256 u1) {
        return router.getUnclaimedFees(who, _key(), LO, HI);
    }

    /// @dev the reserve must always be held as real tokens; an unbacked credit is theft.
    function _assertReserveBacked() internal view {
        assertGe(tokenA.balanceOf(address(router)), router.feeReserve(address(tokenA)), "tokenA reserve backed");
        assertGe(tokenB.balanceOf(address(router)), router.feeReserve(address(tokenB)), "tokenB reserve backed");
    }

    // ================================================================ the split

    /// @notice the heart of the bug: when a second LP joins a range that already has accrued fees,
    ///         they must pay the *whole* principal. Netting the slot's fees against their payment
    ///         would hand them the first LP's earnings.
    function test_secondLpPaysTheFullPrincipal_andTheFeesStayInTheReserve() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);

        _add(address(this), 1e20, 0);
        _swap(true, 5e18); // accrue fees on the shared slot
        _swap(false, 5e18);

        (uint256 a0, uint256 b0) = _unclaimed(address(this));
        assertGt(a0 + b0, 0, "the first LP has genuinely earned fees");

        uint256 aBefore = tokenA.balanceOf(LP2);
        uint256 bBefore = tokenB.balanceOf(LP2);
        BalanceDelta cd = _add(LP2, 5e19, 0);

        // LP2 funded exactly what they owe — no fee-funded discount
        uint256 paidA = aBefore - tokenA.balanceOf(LP2);
        uint256 paidB = bBefore - tokenB.balanceOf(LP2);
        assertEq(paidA, uint256(-amount0(cd)), "tokenA: paid the full principal");
        assertEq(paidB, uint256(-amount1(cd)), "tokenB: paid the full principal");
        assertGt(paidA, 0, "there really was a principal to pay");

        // ...and the fees that made the difference are held here, earmarked for LP1
        assertGt(router.feeReserve(address(tokenA)) + router.feeReserve(address(tokenB)), 0, "fees booked, not netted away");
        (uint256 lp2a, uint256 lp2b) = _unclaimed(LP2);
        assertEq(lp2a, 0, "a fresh LP has earned nothing");
        assertEq(lp2b, 0, "a fresh LP has earned nothing");

        (uint256 a1, uint256 b1) = _unclaimed(address(this));
        assertEq(a1, a0, "the first LP's claim is untouched by the join");
        assertEq(b1, b0, "the first LP's claim is untouched by the join");
        assertEq(a1, router.feeReserve(address(tokenA)), "reserve covers exactly LP1's tokenA claim");
        assertEq(b1, router.feeReserve(address(tokenB)), "reserve covers exactly LP1's tokenB claim");
        _assertReserveBacked();
    }

    /// @notice a second LP who joins and immediately leaves must not inherit the fees that accrued
    ///         before they arrived — and must not be able to drain them.
    function test_secondLpRemovalDrainsNoneOfTheFirstLpsFees() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);

        _add(address(this), 1e20, 0);
        _swap(true, 5e18);
        _swap(false, 5e18);

        (uint256 aBefore, uint256 bBefore) = _unclaimed(address(this));
        assertGt(aBefore + bBefore, 0, "fees on the table");

        _add(LP2, 5e19, 0);
        // no trading between the join and the exit, so the slot produced nothing new
        _remove(LP2, -int256(uint256(5e19)));

        (uint256 aAfter, uint256 bAfter) = _unclaimed(address(this));
        assertEq(aAfter, aBefore, "LP1's tokenA claim survived LP2's round trip");
        assertEq(bAfter, bBefore, "LP1's tokenB claim survived LP2's round trip");
        _assertReserveBacked();

        // LP2 leaves with their principal and nothing else
        (uint256 lp2a, uint256 lp2b) = _unclaimed(LP2);
        assertEq(lp2a, 0, "LP2 earned no tokenA");
        assertEq(lp2b, 0, "LP2 earned no tokenB");

        // and LP1 can still collect every wei that was theirs
        uint256 ra = tokenA.balanceOf(address(this));
        uint256 rb = tokenB.balanceOf(address(this));
        vm.prank(address(this));
        (uint256 gotA, uint256 gotB) = router.collectFees(key, LO, HI, address(this));
        assertEq(gotA, aBefore, "collected the full tokenA claim");
        assertEq(gotB, bBefore, "collected the full tokenB claim");
        assertEq(tokenA.balanceOf(address(this)) - ra, aBefore, "tokenA actually arrived");
        assertEq(tokenB.balanceOf(address(this)) - rb, bBefore, "tokenB actually arrived");
        _assertReserveBacked();
    }

    /// @notice once two LPs share the range, new fees split between them by their own liquidity and
    ///         their own checkpoint — each removal only ever realizes its owner's share.
    function test_sharedRangeFeesSplitBetweenBothLpsOnRemoval() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);

        _add(address(this), 1e20, 0);
        _add(LP2, 1e20, 0); // equal shares, no fees yet
        _swap(true, 5e18);
        _swap(false, 5e18);

        (uint256 lp1a, uint256 lp1b) = _unclaimed(address(this));
        (uint256 lp2a, uint256 lp2b) = _unclaimed(LP2);
        assertGt(lp1a + lp1b, 0, "LP1 earned a share");
        assertGt(lp2a + lp2b, 0, "LP2 earned a share");
        // equal liquidity over an identical fee window -> identical shares
        assertEq(lp1a, lp2a, "tokenA shares match the equal liquidity");
        assertEq(lp1b, lp2b, "tokenB shares match the equal liquidity");

        // LP1 exits first: they walk away with their principal plus exactly their own share, and
        // nothing of LP2's. (Under netting they would have taken the slot's entire fee pot.)
        uint256 aBefore = tokenA.balanceOf(address(this));
        uint256 bBefore = tokenB.balanceOf(address(this));
        (BalanceDelta cd, BalanceDelta fees) = _remove(address(this), -int256(uint256(1e20)));
        uint256 feeA = uint256(_side(key, fees, address(tokenA)));
        uint256 feeB = uint256(_side(key, fees, address(tokenB)));
        assertEq(feeA, lp1a, "LP1 realized exactly their tokenA share");
        assertEq(feeB, lp1b, "LP1 realized exactly their tokenB share");
        assertEq(tokenA.balanceOf(address(this)) - aBefore, uint256(_side(key, cd, address(tokenA))) + feeA, "tokenA = principal + own fees");
        assertEq(tokenB.balanceOf(address(this)) - bBefore, uint256(_side(key, cd, address(tokenB))) + feeB, "tokenB = principal + own fees");
        assertLt(feeA + feeB, lp1a + lp1b + lp2a + lp2b, "LP1 did not take LP2's share too");
        _assertReserveBacked();

        // LP2's claim is still intact and collectable after LP1 has left
        (uint256 lp2aStill, uint256 lp2bStill) = _unclaimed(LP2);
        assertEq(lp2aStill, lp2a, "LP2's tokenA claim untouched by LP1's exit");
        assertEq(lp2bStill, lp2b, "LP2's tokenB claim untouched by LP1's exit");

        vm.prank(LP2);
        (uint256 gotA, uint256 gotB) = router.collectFees(key, LO, HI, LP2);
        assertEq(gotA, lp2a, "LP2 collected exactly their tokenA share");
        assertEq(gotB, lp2b, "LP2 collected exactly their tokenB share");
        _assertReserveBacked();

        // nothing is left owing and nothing is stranded
        assertLe(router.feeReserve(address(tokenA)), 2, "tokenA reserve drained");
        assertLe(router.feeReserve(address(tokenB)), 2, "tokenB reserve drained");
        assertLe(tokenA.balanceOf(address(router)), 2, "tokenA not stranded in the router");
        assertLe(tokenB.balanceOf(address(router)), 2, "tokenB not stranded in the router");
    }

    /// @notice an LP who never adds or removes must still be able to collect — the accrual is a
    ///         pure function of their own liquidity and checkpoint, not of a principal movement.
    function test_collectFeesRealisesWithoutAnyLiquidityChange() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);
        _add(address(this), 1e20, 0);
        _swap(true, 5e18);
        _swap(false, 5e18);

        (uint256 expectA, uint256 expectB) = _unclaimed(address(this));
        assertGt(expectA + expectB, 0, "something to collect");

        uint256 ra = tokenA.balanceOf(address(this));
        uint256 rb = tokenB.balanceOf(address(this));
        (uint256 gotA, uint256 gotB) = router.collectFees(key, LO, HI, address(this));
        assertEq(gotA, expectA, "tokenA paid what the view promised");
        assertEq(gotB, expectB, "tokenB paid what the view promised");
        assertEq(tokenA.balanceOf(address(this)) - ra, expectA, "tokenA arrived");
        assertEq(tokenB.balanceOf(address(this)) - rb, expectB, "tokenB arrived");

        // a second collect in the same state finds nothing new
        (uint256 againA, uint256 againB) = router.collectFees(key, LO, HI, address(this));
        assertEq(againA, 0, "no double pay");
        assertEq(againB, 0, "no double pay");

        // liquidity itself was never touched
        assertEq(router.getPositionLiquidity(address(this), key, LO, HI), 1e20, "position intact");
        _assertReserveBacked();
    }

    /// @notice a `liquidityDelta == 0` poke realises fees to the chosen recipient, exactly like a
    ///         removal would, without moving any liquidity.
    function test_pokeRealisesFeesToTheRecipient() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);
        _add(address(this), 1e20, 0);
        _swap(true, 5e18);

        (uint256 expectA, uint256 expectB) = _unclaimed(address(this));
        assertGt(expectA + expectB, 0, "something to poke out");

        address sink = makeAddr("sink");
        uint256 ra = tokenA.balanceOf(sink);
        uint256 rb = tokenB.balanceOf(sink);
        vm.prank(address(this));
        (BalanceDelta cd, BalanceDelta fees) = router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: LO, tickUpper: HI, liquidityDelta: 0}), sink, _unbounded(), FAR_DEADLINE
        );
        assertEq(amount0(cd), 0, "a poke moves no principal");
        assertEq(amount1(cd), 0, "a poke moves no principal");
        assertEq(uint256(amount0(fees)) + uint256(amount1(fees)), expectA + expectB, "reported exactly what was owed");
        assertEq(tokenA.balanceOf(sink) - ra, expectA, "tokenA to the recipient");
        assertEq(tokenB.balanceOf(sink) - rb, expectB, "tokenB to the recipient");
        _assertReserveBacked();
    }

    /// @notice over-removal is still attributed per wallet: one LP cannot burn another's liquidity.
    function test_overRemovalStillRevertsForTheSecondLp() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);
        _add(address(this), 1e20, 0);
        _add(LP2, 5e19, 0);

        vm.prank(LP2);
        vm.expectRevert(abi.encodeWithSelector(Router.InsufficientPositionLiquidity.selector, 1e20, 5e19));
        router.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: LO, tickUpper: HI, liquidityDelta: -int256(uint256(1e20))}),
            LP2,
            _unbounded(),
            FAR_DEADLINE
        );
    }

    /// @notice native fees are real ETH sitting in the router. They must never be swept back to
    ///         whichever caller happened to arrive with `msg.value` — that is the same theft, in ETH.
    function test_nativeFeeReserveIsNotRefundedToTheNextCaller() public {
        PoolKey memory key = PoolKey({
            currency0: ADDRESS_ZERO(),
            currency1: currency.wrap(address(tokenB)),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        router.initialize(key, Q96_PF);

        vm.prank(address(this));
        router.modifyLiquidity{value: 100e18}(
            key,
            ModifyLiquidityParams({tickLower: LO, tickUpper: HI, liquidityDelta: 1e20}),
            address(this),
            _unbounded(),
            FAR_DEADLINE
        );

        // sell native for tokenB: the LP fee is taken in native
        router.exactInputSingle{value: 5e18}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: int256(5e18), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1}),
            address(this),
            0,
            FAR_DEADLINE
        );
        // whatever the swap did not consume came straight back; only real fees stay
        assertEq(address(router).balance, router.feeReserve(address(0)), "router holds exactly the native reserve");

        uint256 lp1Native = address(this).balance;
        (uint256 expectNative,) = router.getUnclaimedFees(address(this), key, LO, HI);
        assertGt(expectNative, 0, "native fees really accrued");
        // they are only *realised* into this contract's reserve once somebody touches the shared
        // slot — until then the manager still holds them, which the reserve invariant must allow
        assertGe(address(router).balance, router.feeReserve(address(0)), "native reserve is backed before the slot is touched");

        // a second LP arrives carrying more than enough ETH: they pay their whole principal and
        // the excess — but never the reserve — comes back
        uint256 lp2Before = LP2.balance;
        vm.prank(LP2);
        router.modifyLiquidity{value: 100e18}(
            key,
            ModifyLiquidityParams({tickLower: LO, tickUpper: HI, liquidityDelta: 1e20}),
            LP2,
            _unbounded(),
            FAR_DEADLINE
        );
        assertLt(LP2.balance, lp2Before, "LP2 paid in");
        assertEq(address(router).balance, router.feeReserve(address(0)), "reserve survived LP2's visit untouched");
        assertGe(router.feeReserve(address(0)), expectNative, "no native fee was handed to LP2");
        assertEq(router.feeReserve(address(0)), expectNative, "LP2's join realised exactly LP1's claim, nothing more");

        // and LP1 can still take every wei of it
        vm.prank(address(this));
        (uint256 gotNative,) = router.collectFees(key, LO, HI, address(this));
        assertEq(gotNative, expectNative, "native fees collected in full");
        assertGe(address(this).balance, lp1Native + expectNative, "LP1 is better off by exactly their fees");
        assertEq(address(router).balance, router.feeReserve(address(0)), "nothing stranded after collection");
        assertEq(router.feeReserve(address(0)), 0, "native reserve drained");
    }

    /// @notice the property the whole design rests on: whatever happens, the router holds at least
    ///         what it has promised, and a caller always moves their full principal.
    function testFuzz_reserveIsNeverOverdrawnByASecondLp(uint96 firstLiq, uint96 secondLiq, uint96 trade) public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);

        uint256 l1 = bound(uint256(firstLiq), 1e16, 1e21);
        uint256 l2 = bound(uint256(secondLiq), 1e16, 1e21);
        uint256 swapAmt = bound(uint256(trade), 1e16, 1e20);

        _add(address(this), int256(l1), 0);
        _swap(true, swapAmt);
        _swap(false, swapAmt);

        uint256 aBefore = tokenA.balanceOf(LP2);
        BalanceDelta cd = _add(LP2, int256(l2), 0);
        assertEq(aBefore - tokenA.balanceOf(LP2), uint256(-amount0(cd)), "LP2 paid full tokenA principal");
        _assertReserveBacked();

        (uint256 u1a,) = _unclaimed(address(this));
        (uint256 u2a,) = _unclaimed(LP2);
        assertLe(u1a + u2a, router.feeReserve(address(tokenA)), "sum of claims never exceeds the reserve");
        _assertReserveBacked();

        // both exit; the reserve must cover them and must not go negative
        _remove(address(this), -int256(uint256(l1)));
        _assertReserveBacked();
        _remove(LP2, -int256(uint256(l2)));
        _assertReserveBacked();
        assertLe(router.feeReserve(address(tokenA)), 2, "tokenA reserve ends at most a rounding wei");
        assertLe(router.feeReserve(address(tokenB)), 2, "tokenB reserve ends at most a rounding wei");
    }

    // ================================================================ hardening: shared-window accounting

    // state for the donate-through-an-unlock-session helper
    PoolKey private _donKey;
    uint256 private _don0;
    uint256 private _don1;

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        pm.donate(_donKey, _don0, _don1);
        _netSettle(_donKey.currency0);
        _netSettle(_donKey.currency1);
        return "";
    }

    function _netSettle(currency c) private {
        if (pm.getCurrencyDelta(address(this), c) < 0) pm.settle(c);
    }

    function _donateAll(uint256 d0, uint256 d1) internal {
        _donKey = _key();
        _don0 = d0;
        _don1 = d1;
        pm.unlock("");
    }

    /// @dev deploy the hook then etch its runtime code at a deterministic "mined" address whose
    ///      low flag bits encode `flags` (bits 0..2 stay clear, as `Hooks.validate` requires).
    function _mineHook(address impl, uint256 flags) internal returns (address hook) {
        bytes memory code = impl.code;
        bytes32 salt = keccak256(abi.encodePacked(code, flags));
        hook = address(uint160((uint256(salt) & ~uint256(0x1FFF)) | flags));
        vm.etch(hook, code);
    }

    function _keyWith(address hook) internal view returns (PoolKey memory) {
        (address lo, address hi) = address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: hook});
    }

    function _addWith(PoolKey memory key, address who, int256 liq, uint256 value) internal returns (BalanceDelta cd) {
        vm.prank(who);
        (cd,) = router.modifyLiquidity{value: value}(
            key, ModifyLiquidityParams({tickLower: LO, tickUpper: HI, liquidityDelta: liq}), who, _unbounded(), FAR_DEADLINE
        );
    }

    /// @notice growth produced by a before-add hook must never be credited to a delta that was
    ///         not in the shared slot while that growth happened. Pre-hardening the checkpoint
    ///         was the *pre*-hook read while the ledger already carried the new delta, so a
    ///         re-joining LP could claim `delta x hook-growth` nobody paid into the reserve —
    ///         draining the other LPs' backed fees and making their collect revert.
    function test_beforeAddHookGrowthIsNeverCreditedToAJoinersDelta() public {
        DonateOnAddHook impl = new DonateOnAddHook(pm, address(tokenA), address(tokenB), 1e18);
        address hook = _mineHook(address(impl), Hooks.BEFORE_ADD_LIQUIDITY_FLAG);
        PoolKey memory key = _keyWith(hook);
        tokenA.mint(hook, 1_000e18);
        tokenB.mint(hook, 1_000e18);
        router.initialize(key, Q96_PF);

        // the first join finds no liquidity to donate to, so it lands undonated
        _addWith(key, address(this), 1e20, 0);
        // LP2 joins (checkpoint starts after this add's donation), then joins AGAIN: the second
        // add is the exploit window — its donation happens after the pre-hook fee-growth read
        _addWith(key, LP2, 1e16, 0);
        _addWith(key, LP2, 2e20, 0);

        (uint256 vA, uint256 vB) = router.getUnclaimedFees(address(this), key, LO, HI);
        (uint256 lA, uint256 lB) = router.getUnclaimedFees(LP2, key, LO, HI);
        assertGt(vA, 0, "donations really accrued to the victim");
        assertGt(router.feeReserve(address(tokenA)), 0, "the hook windows were booked to the reserve");
        // every claim must be backed by what the manager actually booked — the joiner's
        // not-in-slot delta used to push this sum over the reserve
        assertLe(vA + lA, router.feeReserve(address(tokenA)), "tokenA: every claim is backed by the reserve");
        assertLe(vB + lB, router.feeReserve(address(tokenB)), "tokenB: every claim is backed by the reserve");
        _assertReserveBacked();

        // and both LPs can collect exactly what the view promised
        uint256 ra = tokenA.balanceOf(address(this));
        (uint256 gotV,) = router.collectFees(key, LO, HI, address(this));
        assertEq(gotV, vA, "victim collected the full claim");
        assertEq(tokenA.balanceOf(address(this)) - ra, gotV, "victim tokenA arrived");

        uint256 rl = tokenA.balanceOf(LP2);
        vm.prank(LP2);
        (uint256 gotL,) = router.collectFees(key, LO, HI, LP2);
        assertEq(gotL, lA, "joiner collected exactly their own share");
        assertEq(tokenA.balanceOf(LP2) - rl, gotL, "joiner tokenA arrived");
        _assertReserveBacked();
    }

    /// @notice the manager books each touch of the shared slot with its own floor while an LP's
    ///         claim floors their whole checkpoint span at once. Anyone can insert foreign
    ///         touches (a collectFees poke) between an LP's ops; on a pool where each window
    ///         accrues less than one wei the summed floors fall below the union floor.
    ///         Pre-hardening the mismatch reverted FeeReserveShortfall — freezing not just the
    ///         fees but the principal behind them, since the flush always pays the ledger first.
    function test_dustWindowPokingCannotStrandFeesOrBlockRemoval() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);
        _add(address(this), 1e20, 0);
        _add(LP2, 1e20, 0);

        // four rounds of exactly one donated wei, each realised in its own window by LP2's poke:
        // every window floors to zero for the manager, while the victim's single union-floor
        // claim across all four windows does not
        bool aIs0 = address(tokenA) < address(tokenB);
        for (uint256 i = 0; i < 4; i++) {
            _donateAll(aIs0 ? 1 : 0, aIs0 ? 0 : 1);
            vm.prank(LP2);
            router.collectFees(key, LO, HI, LP2);
        }
        assertEq(router.feeReserve(address(tokenA)), 0, "every window floored to zero");
        (uint256 uA, uint256 uB) = router.getUnclaimedFees(address(this), key, LO, HI);
        assertGe(uA, 1, "the union-floor claim is real");
        assertEq(uB, 0, "only tokenA was donated");

        // collecting pays whatever the reserve backs and never reverts on the shortfall
        uint256 ra = tokenA.balanceOf(address(this));
        (uint256 gotA,) = router.collectFees(key, LO, HI, address(this));
        assertEq(gotA, 0, "the reserve backs nothing yet");
        assertEq(tokenA.balanceOf(address(this)) - ra, gotA, "tokenA arrived");
        _assertReserveBacked();
        // the unpaid remainder stays claimed in the ledger instead of stranding the operation
        (uint256 uA2,) = router.getUnclaimedFees(address(this), key, LO, HI);
        assertEq(uA2, uA - gotA, "remainder kept in the ledger");

        // and the principal is never frozen behind the fee shortfall
        (BalanceDelta cd,) = _remove(address(this), -int256(uint256(1e20)));
        assertGt(uint256(amount0(cd)) + uint256(amount1(cd)), 0, "principal came back");
        assertEq(router.getPositionLiquidity(address(this), key, LO, HI), 0, "position closed");
        _assertReserveBacked();
    }

    /// @notice a caller with no position and nothing to add must not touch the shared slot at
    ///         all: the poke only realised the slot's fees as a side effect, which both leaked
    ///         state to a non-holder and fragmented every real LP's accrual window.
    function test_emptyLedgerPokeNeverTouchesTheSharedSlot() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96_PF);
        _add(address(this), 1e20, 0);
        _add(LP2, 1e20, 0);
        _swap(true, 5e18);
        _swap(false, 5e18);
        assertEq(router.feeReserve(address(tokenA)), 0, "growth not yet booked by any touch");

        address outsider = makeAddr("outsider");
        vm.prank(outsider);
        (uint256 oA, uint256 oB) = router.collectFees(key, LO, HI, outsider);
        assertEq(oA, 0, "nothing to pay a non-holder");
        assertEq(oB, 0, "nothing to pay a non-holder");
        assertEq(router.feeReserve(address(tokenA)), 0, "an empty-ledger poke books nothing");
        assertEq(router.feeReserve(address(tokenB)), 0, "an empty-ledger poke books nothing");

        // the fees are untouched and still fully collectable by a real holder
        (uint256 expectA, uint256 expectB) = router.getUnclaimedFees(address(this), key, LO, HI);
        assertGt(expectA + expectB, 0, "swap fees really accrued");
        uint256 ra = tokenA.balanceOf(address(this));
        (uint256 gotA,) = router.collectFees(key, LO, HI, address(this));
        assertEq(gotA, expectA, "holder collects in full");
        assertEq(tokenA.balanceOf(address(this)) - ra, gotA, "tokenA arrived");
        _assertReserveBacked();
    }
}
