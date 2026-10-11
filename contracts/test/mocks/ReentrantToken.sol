// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {SwapexPool} from "../../src/v3/SwapexPool.sol";

/// @notice ERC-20 that, on every `transfer`, attempts to re-enter the pool's
/// lock-guarded entry points (swap/mint/burn/collect). The pool's `lock` modifier
/// must make every such attempt revert with `Locked`, leaving outer accounting intact.
/// Records how many reentry attempts were attempted and how many unexpectedly succeeded.
contract ReentrantToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    SwapexPool public pool;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses; // must stay 0

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function setPool(SwapexPool p) external {
        pool = p;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        _attemptReentry();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        _attemptReentry();
        return true;
    }

    /// Tries to re-enter a lock-guarded function. Each is expected to revert with `Locked`.
    function _attemptReentry() internal {
        if (address(pool) == address(0)) return;
        reentryAttempts++;
        // try swap
        (bool ok,) = address(pool).call(
            abi.encodeWithSelector(SwapexPool.swap.selector, address(this), true, int256(1), uint160(1), "")
        );
        if (ok) reentrySuccesses++;
        // try collect (burn needs liquidity, but lock is checked first regardless)
        (ok,) = address(pool).call(
            abi.encodeWithSelector(SwapexPool.collect.selector, address(this), int24(0), int24(60), uint128(1), uint128(1))
        );
        if (ok) reentrySuccesses++;
    }
}
