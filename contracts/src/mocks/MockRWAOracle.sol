// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";

/// @title MockRWAOracle
/// @notice TEST-ONLY Morpho Blue oracle for the mSPY/mUSDC demo market. Prices are set manually to simulate market
/// moves (e.g. a crash). This is NOT market data and must never be used for a production market.
/// @dev Morpho expects `price()` to be the price of 1 collateral *unit* quoted in loan-token *units*, scaled by 1e36.
/// For a human price P (loan tokens per whole collateral token, 8 decimals):
///     price() = P_e8 * 10^(36 + loanDecimals - collateralDecimals - 8)
/// e.g. mSPY (18 dec) at $500 in mUSDC (6 dec): 500e8 * 10^16 = 5e26, so 4e18 units are worth
/// 4e18 * 5e26 / 1e36 = 2000e6 mUSDC units = $2,000.
contract MockRWAOracle is IOracle, AccessControl {
    bytes32 public constant PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER_ROLE");

    bool public constant IS_TEST_ORACLE = true;
    string public constant DESCRIPTION =
        "TEST-ONLY mock RWA oracle: prices are set manually for demos and are NOT market data.";

    /// @notice Decimals of the human-readable price inputs (Chainlink-style).
    uint8 public constant INPUT_DECIMALS = 8;
    uint256 public constant MIN_PRICE_E8 = 1e6; // $0.01
    uint256 public constant MAX_PRICE_E8 = 1e14; // $1,000,000
    uint256 public constant MAX_SHOCK_BPS = 9900; // a single shock moves the price by at most -99%
    uint256 internal constant BPS = 10_000;

    uint8 public immutable COLLATERAL_DECIMALS;
    uint8 public immutable LOAN_DECIMALS;
    /// @notice Multiplier converting an 8-decimal human price into Morpho's oracle scale.
    uint256 public immutable SCALE;
    uint256 public immutable INITIAL_PRICE_E8;

    uint256 public priceE8;
    uint256 public lastUpdatedAt;

    event TestPriceUpdated(address indexed updater, uint256 oldPriceE8, uint256 newPriceE8, uint256 morphoPrice);

    error ZeroAdmin();
    error UnsupportedDecimals(uint8 collateralDecimals, uint8 loanDecimals);
    error InvalidTestPrice(uint256 priceE8);
    error InvalidShock(uint256 dropBps);

    constructor(address admin, uint8 collateralDecimals, uint8 loanDecimals, uint256 initialPriceE8) {
        if (admin == address(0)) revert ZeroAdmin();
        // Keep the scale an exact integer power of ten.
        if (
            collateralDecimals > 36 || loanDecimals > 36
                || uint256(36) + loanDecimals < uint256(collateralDecimals) + INPUT_DECIMALS
        ) revert UnsupportedDecimals(collateralDecimals, loanDecimals);
        _validatePrice(initialPriceE8);

        COLLATERAL_DECIMALS = collateralDecimals;
        LOAN_DECIMALS = loanDecimals;
        SCALE = 10 ** (uint256(36) + loanDecimals - collateralDecimals - INPUT_DECIMALS);
        INITIAL_PRICE_E8 = initialPriceE8;

        priceE8 = initialPriceE8;
        lastUpdatedAt = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRICE_UPDATER_ROLE, admin);
        emit TestPriceUpdated(admin, 0, initialPriceE8, initialPriceE8 * SCALE);
    }

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        return priceE8 * SCALE;
    }

    /// @notice Converts an 8-decimal human price to Morpho's oracle scale.
    function toMorphoPrice(uint256 humanPriceE8) external view returns (uint256) {
        return humanPriceE8 * SCALE;
    }

    /// @notice TEST ONLY: set the collateral price (8 decimals, quoted in loan tokens).
    function setTestPrice(uint256 newPriceE8) external onlyRole(PRICE_UPDATER_ROLE) {
        _setPrice(newPriceE8);
    }

    /// @notice TEST ONLY: drop the current price by `dropBps` basis points (2000 = -20%).
    function applyTestPriceShock(uint256 dropBps) external onlyRole(PRICE_UPDATER_ROLE) {
        if (dropBps == 0 || dropBps > MAX_SHOCK_BPS) revert InvalidShock(dropBps);
        _setPrice(priceE8 * (BPS - dropBps) / BPS);
    }

    /// @notice TEST ONLY: restore the initial price.
    function resetTestPrice() external onlyRole(PRICE_UPDATER_ROLE) {
        _setPrice(INITIAL_PRICE_E8);
    }

    function _setPrice(uint256 newPriceE8) internal {
        _validatePrice(newPriceE8);
        uint256 old = priceE8;
        priceE8 = newPriceE8;
        lastUpdatedAt = block.timestamp;
        emit TestPriceUpdated(msg.sender, old, newPriceE8, newPriceE8 * SCALE);
    }

    function _validatePrice(uint256 p) internal pure {
        if (p < MIN_PRICE_E8 || p > MAX_PRICE_E8) revert InvalidTestPrice(p);
    }
}
