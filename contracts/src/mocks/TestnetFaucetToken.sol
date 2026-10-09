// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TestnetFaucetToken
/// @notice ERC-20 with a rate-limited public faucet and a role-gated mint. TESTNET / DEMO USE ONLY.
/// @dev The public faucet is limited per call and per address per rolling window, so anyone can get demo funds
/// without being able to mint unbounded supply. Accounts with MINTER_ROLE (the deployer) can mint freely for seeding.
abstract contract TestnetFaucetToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bool public constant IS_TESTNET_TOKEN = true;
    uint256 public constant FAUCET_WINDOW = 1 days;

    uint8 private immutable _decimals;
    uint256 public immutable faucetMaxPerCall;
    uint256 public immutable faucetMaxPerWindow;

    mapping(address account => uint256) public faucetWindowStart;
    mapping(address account => uint256) public faucetMintedInWindow;

    event FaucetMinted(address indexed to, uint256 amount);

    error FaucetZeroAmount();
    error FaucetPerCallLimitExceeded(uint256 requested, uint256 maxPerCall);
    error FaucetWindowLimitExceeded(uint256 requested, uint256 remaining);
    error InvalidFaucetLimits();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 maxPerCall,
        uint256 maxPerWindow,
        address admin
    ) ERC20(name_, symbol_) {
        if (maxPerCall == 0 || maxPerWindow < maxPerCall) revert InvalidFaucetLimits();
        _decimals = decimals_;
        faucetMaxPerCall = maxPerCall;
        faucetMaxPerWindow = maxPerWindow;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint `amount` demo tokens to the caller, subject to the faucet limits.
    function faucet(uint256 amount) external {
        if (amount == 0) revert FaucetZeroAmount();
        if (amount > faucetMaxPerCall) revert FaucetPerCallLimitExceeded(amount, faucetMaxPerCall);

        if (block.timestamp >= faucetWindowStart[msg.sender] + FAUCET_WINDOW) {
            faucetWindowStart[msg.sender] = block.timestamp;
            faucetMintedInWindow[msg.sender] = 0;
        }
        uint256 remaining = faucetMaxPerWindow - faucetMintedInWindow[msg.sender];
        if (amount > remaining) revert FaucetWindowLimitExceeded(amount, remaining);

        faucetMintedInWindow[msg.sender] += amount;
        _mint(msg.sender, amount);
        emit FaucetMinted(msg.sender, amount);
    }

    /// @notice Amount `account` can still claim from the faucet in the current window.
    function faucetRemaining(address account) external view returns (uint256) {
        if (block.timestamp >= faucetWindowStart[account] + FAUCET_WINDOW) return faucetMaxPerWindow;
        return faucetMaxPerWindow - faucetMintedInWindow[account];
    }

    /// @notice Unrestricted mint for seeding demo environments.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
