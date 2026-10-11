// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @notice ERC-20 that skims a fee (in bps) from every `transfer`/`transferFrom`.
/// The recipient receives `amount - fee`; the sender is debited the full `amount`.
/// The fee is mutable so tests can seed liquidity with the fee off, then enable it
/// to exercise the pool's under-payment rejection. Proves the pool fails loudly
/// (InsufficientPayment) rather than silently crediting itself less than it debits.
contract FeeOnTransferToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    uint256 public feeBps; // e.g. 100 = 1%; mutable for test setup
    uint256 public constant BPS = 10_000;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d, uint256 feeBps_) {
        name = n;
        symbol = s;
        decimals = d;
        feeBps = feeBps_;
    }

    function setFeeBps(uint256 f) external {
        feeBps = f;
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
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        uint256 fee = (amount * feeBps) / BPS;
        balanceOf[from] -= amount; // sender debited full amount
        balanceOf[to] += amount - fee; // recipient gets amount minus fee
        totalSupply -= fee; // fee burned
        emit Transfer(from, to, amount - fee);
        return true;
    }
}
