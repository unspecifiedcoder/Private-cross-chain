// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;


import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";


contract LockContract is Ownable {
IERC20 public token;
address public relayer;


event Locked(address indexed user, uint256 amount, bytes32 indexed swapId, string targetAlgorandAddr);
event Released(address indexed to, uint256 amount, bytes32 indexed swapId);


constructor(IERC20 _token) {
token = _token;
}


function setRelayer(address _r) external onlyOwner {
relayer = _r;
}


// user must approve this contract for `amount` first
function lock(uint256 amount, bytes32 swapId, string calldata targetAlgorandAddr) external {
require(amount > 0, "bad amount");
require(bytes(targetAlgorandAddr).length > 0, "target required");
bool ok = token.transferFrom(msg.sender, address(this), amount);
require(ok, "transfer failed");
emit Locked(msg.sender, amount, swapId, targetAlgorandAddr);
}


// only relayer or owner can release locked tokens back to EVM addresses
function release(address to, uint256 amount, bytes32 swapId) external {
require(msg.sender == relayer || msg.sender == owner(), "only relayer/owner");
require(amount > 0, "bad amount");
bool ok = token.transfer(to, amount);
require(ok, "transfer failed");
emit Released(to, amount, swapId);
}
}