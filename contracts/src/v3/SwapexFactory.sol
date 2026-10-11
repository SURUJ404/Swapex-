// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {SwapexPool} from "./SwapexPool.sol";

/// Deploys one SwapexPool per (token0, token1, fee) at a deterministic CREATE2 address.
contract SwapexFactory {
    error NotOwner();
    error IdenticalTokens();
    error ZeroAddress();
    error FeeNotEnabled();
    error PoolExists();
    error InvalidFee();
    error InvalidTickSpacing();
    error FeeAlreadyEnabled();

    event OwnerChanged(address indexed oldOwner, address indexed newOwner);
    event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool);
    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);

    struct Parameters {
        address factory;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
    }

    address public owner;
    mapping(uint24 => int24) public feeAmountTickSpacing;
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    /// @dev set only during pool creation; the pool reads it in its constructor
    Parameters public parameters;

    constructor() {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
        _enable(500, 10);
        _enable(3000, 60);
        _enable(10000, 200);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        if (tokenA == tokenB) revert IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        int24 tickSpacing = feeAmountTickSpacing[fee];
        if (tickSpacing == 0) revert FeeNotEnabled();
        if (getPool[token0][token1][fee] != address(0)) revert PoolExists();

        parameters = Parameters({factory: address(this), token0: token0, token1: token1, fee: fee, tickSpacing: tickSpacing});
        pool = address(new SwapexPool{salt: keccak256(abi.encode(token0, token1, fee))}());
        delete parameters;

        getPool[token0][token1][fee] = pool;
        getPool[token1][token0][fee] = pool; // both orders resolve to the same pool
        emit PoolCreated(token0, token1, fee, tickSpacing, pool);
    }

    /// @notice address a pool has (or will have), without deploying
    function computePoolAddress(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 salt = keccak256(abi.encode(token0, token1, fee));
        bytes32 initCodeHash = keccak256(type(SwapexPool).creationCode);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    function setOwner(address newOwner) external onlyOwner {
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function enableFeeAmount(uint24 fee, int24 tickSpacing) external onlyOwner {
        _enable(fee, tickSpacing);
    }

    function _enable(uint24 fee, int24 tickSpacing) private {
        if (fee >= 1_000_000) revert InvalidFee();
        // < 16384 keeps (tick / spacing) * spacing arithmetic inside int24
        if (tickSpacing <= 0 || tickSpacing >= 16384) revert InvalidTickSpacing();
        if (feeAmountTickSpacing[fee] != 0) revert FeeAlreadyEnabled();
        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
    }
}
