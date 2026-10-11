// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {SwapexFactory} from "../../src/v3/SwapexFactory.sol";
import {SwapexPool} from "../../src/v3/SwapexPool.sol";
import {ISwapexMintCallback, ISwapexSwapCallback, ISwapexFlashCallback} from "../../src/interfaces/ICallbacks.sol";

/// Test actor that is LP, trader and flash borrower, paying the pool from its own balance.
abstract contract V3Base is Test, ISwapexMintCallback, ISwapexSwapCallback, ISwapexFlashCallback {
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant Q96 = uint160(1 << 96);

    SwapexFactory internal factory;
    SwapexPool internal pool;
    MockERC20 internal token0;
    MockERC20 internal token1;

    /// set by tests that want the swap callback to underpay or the flash callback to skip repayment
    bool internal underpay;
    uint256 internal flashExtra;

    function setUp() public virtual {
        factory = new SwapexFactory();

        MockERC20 a = new MockERC20("Token A", "TKA", 18);
        MockERC20 b = new MockERC20("Token B", "TKB", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        pool = SwapexPool(factory.createPool(address(token0), address(token1), FEE));
        pool.initialize(Q96); // price 1.0, tick 0

        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);
    }

    // ---- pool callbacks ----
    function swapexMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        require(msg.sender == address(pool), "not pool");
        if (amount0Owed > 0) token0.transfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) token1.transfer(msg.sender, amount1Owed);
    }

    function swapexSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == address(pool), "not pool");
        if (underpay) return;
        if (amount0Delta > 0) token0.transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) token1.transfer(msg.sender, uint256(amount1Delta));
    }

    function swapexFlashCallback(uint256 fee0, uint256 fee1, bytes calldata) external {
        require(msg.sender == address(pool), "not pool");
        // repay principal (already in our balance) + fee, optionally short by flashExtra
        token0.transfer(msg.sender, fee0 + 1e18 - flashExtra);
        token1.transfer(msg.sender, fee1 + 1e18 - flashExtra);
    }

    // ---- helpers ----
    function _positionKey(address owner, int24 lower, int24 upper) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, lower, upper));
    }

    function _limit(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? uint160(uint256(Q96) * 9 / 10) : uint160(uint256(Q96) * 11 / 10);
    }

    function _swapExactIn(bool zeroForOne, uint256 amountIn) internal returns (int256 d0, int256 d1) {
        (d0, d1) = pool.swap(address(this), zeroForOne, int256(amountIn), _limit(zeroForOne), "");
    }

    function assertEq_(uint256 a, uint256 b) internal {
        assertEq(a, b);
    }

    function assertEqInt_(int256 a, int256 b) internal {
        assertEq(a, b);
    }
}
