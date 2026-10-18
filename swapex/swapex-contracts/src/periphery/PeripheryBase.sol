// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {TransferHelper} from "../libraries/TransferHelper.sol";
import {IWETH9, IERC20Permit, ISwapexFactoryPeriphery} from "../interfaces/IPeriphery.sol";

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// Shared plumbing for the router and the position manager: factory/WETH, deadlines, payments, native ETH,
/// multicall, and permit-based approvals.
abstract contract PeripheryBase {
    error Expired();
    error NotWETH();
    error InsufficientToken();
    error InsufficientETH();
    error PermitFailed();
    error ZeroRecipient();

    /// @dev pass this as `recipient` to keep funds in the periphery contract (to unwrap or sweep afterwards)
    address internal constant ADDRESS_THIS = address(2);

    address public immutable factory;
    address public immutable WETH9;

    constructor(address factory_, address weth9_) {
        factory = factory_;
        WETH9 = weth9_;
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    receive() external payable {
        if (msg.sender != WETH9) revert NotWETH();
    }

    function _resolve(address recipient) internal view returns (address) {
        if (recipient == address(0)) revert ZeroRecipient(); // never burn funds by accident
        return recipient == ADDRESS_THIS ? address(this) : recipient;
    }

    /// @dev pay `value` of `token` to `to`: wraps held ETH for WETH, spends own balance, or pulls from `payer`
    function _pay(address token, address payer, address to, uint256 value) internal {
        if (token == WETH9 && address(this).balance >= value) {
            IWETH9(WETH9).deposit{value: value}();
            IWETH9(WETH9).transfer(to, value);
        } else if (payer == address(this)) {
            TransferHelper.safeTransfer(token, to, value);
        } else {
            TransferHelper.safeTransferFrom(token, payer, to, value);
        }
    }

    // ---------------------------------------------------------------- native ETH helpers
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable {
        uint256 balance = IWETH9(WETH9).balanceOf(address(this));
        if (balance < amountMinimum) revert InsufficientETH();
        if (balance > 0) {
            IWETH9(WETH9).withdraw(balance);
            TransferHelper.safeTransferETH(_resolveExternal(recipient), balance);
        }
    }

    function sweepToken(address token, uint256 amountMinimum, address recipient) external payable {
        uint256 balance = IERC20Balance(token).balanceOf(address(this));
        if (balance < amountMinimum) revert InsufficientToken();
        if (balance > 0) TransferHelper.safeTransfer(token, _resolveExternal(recipient), balance);
    }

    function refundETH() external payable {
        if (address(this).balance > 0) TransferHelper.safeTransferETH(msg.sender, address(this).balance);
    }

    function _resolveExternal(address recipient) private pure returns (address) {
        if (recipient == address(0) || recipient == ADDRESS_THIS) revert ZeroRecipient();
        return recipient;
    }

    // ---------------------------------------------------------------- multicall
    /// @notice run several calls on this contract in one transaction (e.g. swap, then unwrapWETH9)
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                if (ret.length == 0) revert();
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = ret;
        }
    }

    // ---------------------------------------------------------------- permit
    /// @notice use an EIP-2612 signature to approve this contract. If the permit was already consumed by someone
    ///         front-running the transaction, the call succeeds as long as the allowance is already sufficient.
    function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable {
        try IERC20Permit(token).permit(msg.sender, address(this), value, deadline, v, r, s) {}
        catch {
            if (IERC20Permit(token).allowance(msg.sender, address(this)) < value) revert PermitFailed();
        }
    }
}
