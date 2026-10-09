// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";

/// @notice A user's protection policy for one Morpho Blue market. LTV values are WAD-scaled (1e18 = 100%).
struct ProtectionPolicy {
    bool enabled;
    uint64 triggerLtv; // protection becomes executable once LTV >= triggerLtv
    uint64 targetLtv; // repayment aims to bring LTV down to targetLtv
    uint32 cooldown; // minimum seconds between two executions (0 = none)
    uint64 lastExecutedAt; // timestamp of the last execution (0 = never)
    uint128 maxRepayPerExecution; // cap per execution, in loan-token units
}

/// @notice Live risk metrics of a borrower position, computed from Morpho state and the market oracle.
struct PositionRisk {
    uint256 collateral; // collateral-token units
    uint256 oraclePrice; // Morpho oracle price, scaled by 1e36 * 10^(loanDecimals - collateralDecimals)
    uint256 collateralValue; // collateral valued in loan-token units
    uint256 borrowShares;
    uint256 debt; // interest-accrued debt in loan-token units, rounded up (same as Morpho's health check)
    uint256 ltv; // WAD; type(uint256).max when debt > 0 and collateral value is 0
    uint256 lltv; // the market's liquidation LTV (WAD)
    uint256 maxBorrow; // collateralValue * lltv
    uint256 liquidationPrice; // oracle price at which ltv == lltv (same scale as oraclePrice), 0 if no debt
    uint256 triggerPrice; // oracle price at which the user's policy triggers, 0 if no debt / no policy
    uint256 priceDropToLiquidation; // WAD fraction the price can still fall before liquidation
    uint256 reserve; // the user's protection reserve for this market (loan-token units)
    bool healthy; // Morpho health: maxBorrow >= debt
}

enum PreviewStatus {
    Executable,
    PolicyDisabled,
    NoDebt,
    BelowTrigger,
    CooldownActive,
    NoReserve,
    InvalidPrice
}

/// @notice What `executeProtection` would do right now (or at a hypothetical price).
struct ProtectionPreview {
    bool executable;
    PreviewStatus status;
    uint256 debt;
    uint256 collateralValue;
    uint256 currentLtv;
    uint256 requiredRepay; // repayment needed to reach targetLtv (incl. a share-rounding margin)
    uint256 repayAmount; // requiredRepay capped by reserve, maxRepayPerExecution and debt
    uint256 expectedDebtAfter; // exact simulation of Morpho's share math
    uint256 expectedLtvAfter;
    uint256 reserveAfter;
    bool targetReachable; // false => reserve/cap cannot restore targetLtv in one execution
    uint256 nextExecutionTime; // earliest timestamp allowed by the cooldown
}

struct ProtectedPosition {
    address user;
    Id id;
}

interface IRWASafetyGuard {
    /* EVENTS */

    event ProtectionConfigured(
        address indexed user,
        Id indexed id,
        bool enabled,
        uint256 triggerLtv,
        uint256 targetLtv,
        uint256 maxRepayPerExecution,
        uint256 cooldown
    );
    event ReserveDeposited(
        address indexed user, Id indexed id, address indexed token, uint256 assets, uint256 newReserve
    );
    event ReserveWithdrawn(
        address indexed user, Id indexed id, address indexed token, uint256 assets, uint256 newReserve
    );
    event ProtectionExecuted(
        address indexed user,
        Id indexed id,
        address indexed executor,
        uint256 assetsRepaid,
        uint256 sharesRepaid,
        uint256 debtBefore,
        uint256 debtAfter,
        uint256 ltvBefore,
        uint256 ltvAfter,
        uint256 reserveAfter,
        bool targetReached
    );

    /* ERRORS */

    error ZeroAddress();
    error ZeroAmount();
    error MarketNotCreated();
    error InvalidLltv();
    error InvalidTriggerLtv(uint256 triggerLtv, uint256 lltv);
    error InvalidTargetLtv(uint256 targetLtv, uint256 triggerLtv);
    error InvalidMaxRepay();
    error InvalidCooldown(uint256 cooldown, uint256 maxCooldown);
    error InsufficientReserve(uint256 requested, uint256 available);
    error ProtectionDisabled();
    error CooldownActive(uint256 nextExecutionTime);
    error NoDebt();
    error PositionHealthy(uint256 ltv, uint256 triggerLtv);
    error InvalidOraclePrice();
    error UnexpectedRepayAmount(uint256 expected, uint256 actual);
    error DebtNotReduced(uint256 debtBefore, uint256 debtAfter);

    /* USER ACTIONS */

    function setProtectionPolicy(
        MarketParams calldata marketParams,
        uint256 triggerLtv,
        uint256 targetLtv,
        uint256 maxRepayPerExecution,
        uint256 cooldown,
        bool enabled
    ) external;

    function disableProtection(MarketParams calldata marketParams) external;

    function depositReserve(MarketParams calldata marketParams, uint256 assets) external returns (uint256 credited);

    function withdrawReserve(MarketParams calldata marketParams, uint256 assets) external returns (uint256 withdrawn);

    /* KEEPER ACTION (permissionless, condition-gated) */

    function executeProtection(MarketParams calldata marketParams, address user)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid);

    /* VIEWS */

    function getProtectionPolicy(address user, Id id) external view returns (ProtectionPolicy memory);

    function reserveOf(address user, Id id) external view returns (uint256);

    function getPositionRisk(MarketParams calldata marketParams, address user)
        external
        view
        returns (PositionRisk memory);

    function previewProtection(MarketParams calldata marketParams, address user)
        external
        view
        returns (ProtectionPreview memory);

    function previewProtectionAtPrice(MarketParams calldata marketParams, address user, uint256 oraclePrice)
        external
        view
        returns (ProtectionPreview memory);

    function protectedPositionsCount() external view returns (uint256);

    function getProtectedPositions(uint256 offset, uint256 limit) external view returns (ProtectedPosition[] memory);
}
