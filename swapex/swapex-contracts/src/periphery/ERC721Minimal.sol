// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

/// Minimal ERC-721 (EIP-721) with no metadata extension beyond what the position manager adds.
/// Kept deliberately small. Before any real-value deployment, replace it with a reviewed library implementation.
abstract contract ERC721Minimal {
    error NotOwnerNorApproved();
    error NonexistentToken();
    error WrongFrom();
    error ZeroAddressTransfer();
    error UnsafeRecipient();
    error SelfApproval();
    error AlreadyMinted();
    error NotTokenOwner();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    mapping(uint256 => address) internal _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NonexistentToken();
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddressTransfer();
        return _balanceOf[owner];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return _approved[tokenId];
    }

    function approve(address spender, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !isApprovedForAll[owner][msg.sender]) revert NotOwnerNorApproved();
        _approved[tokenId] = spender;
        emit Approval(owner, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert SelfApproval();
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf(tokenId);
        return spender == owner || _approved[tokenId] == spender || isApprovedForAll[owner][spender];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ZeroAddressTransfer();
        if (_ownerOf[tokenId] != from) revert WrongFrom();
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotOwnerNorApproved();
        unchecked {
            _balanceOf[from]--;
            _balanceOf[to]++;
        }
        _ownerOf[tokenId] = to;
        delete _approved[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkReceiver(msg.sender, from, to, tokenId, data);
    }

    function supportsInterface(bytes4 id) external pure virtual returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f; // ERC-721 metadata
    }

    function _mint(address to, uint256 tokenId) internal {
        if (to == address(0)) revert ZeroAddressTransfer();
        if (_ownerOf[tokenId] != address(0)) revert AlreadyMinted();
        unchecked {
            _balanceOf[to]++;
        }
        _ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function _burn(uint256 tokenId) internal {
        address owner = ownerOf(tokenId);
        unchecked {
            _balanceOf[owner]--;
        }
        delete _ownerOf[tokenId];
        delete _approved[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    function _checkReceiver(address operator, address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(operator, from, tokenId, data) returns (bytes4 ret) {
            if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
        } catch {
            revert UnsafeRecipient();
        }
    }
}
