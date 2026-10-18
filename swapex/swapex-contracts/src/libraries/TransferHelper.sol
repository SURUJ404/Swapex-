// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

/// ERC-20 transfers that tolerate tokens returning nothing (USDT-style) and revert on `false` or failure.
library TransferHelper {
    error TransferFailed();
    error EthTransferFailed();

    function safeTransfer(address token, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value)); // transfer(address,uint256)
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value)); // transferFrom(address,address,uint256)
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function safeTransferETH(address to, uint256 value) internal {
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert EthTransferFailed();
    }
}
