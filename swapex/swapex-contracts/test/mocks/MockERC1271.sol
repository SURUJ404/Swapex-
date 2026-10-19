// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal ERC-1271 wallet for tests: an EOA owner validates the signature. Not for production.
contract MockERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        address recovered = ecrecover(hash, v, r, s);
        return recovered != address(0) && recovered == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff); // IERC1271.isValidSignature
    }

    /// let the wallet approve a spender (e.g. the limit-order contract)
    function approve(address token, address spender, uint256 amount) external {
        (bool ok,) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve(address,uint256)
        require(ok, "approve failed");
    }
}
