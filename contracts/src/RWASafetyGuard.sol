// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMorpho, Id, MarketParams, Market, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MathLib, WAD} from "morpho-blue/src/libraries/MathLib.sol";
import {UtilsLib} from "morpho-blue/src/libraries/UtilsLib.sol";
import {ORACLE_PRICE_SCALE} from "morpho-blue/src/libraries/ConstantsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

import {
    IRWASafetyGuard,
    ProtectionPolicy,
    PositionRisk,
    PreviewStatus,
    ProtectionPreview,
    ProtectedPosition
} from "./interfaces/IRWASafetyGuard.sol";

/// @title RWASafetyGuard
/// @notice Automated collateral protection for Morpho Blue borrowers.
/// @dev Users deposit loan tokens as a per-market protection reserve and configure a policy (trigger LTV, target LTV,
/// max repayment, cooldown). When the position's LTV — computed from Morpho's interest-accrued debt and the market's
/// own oracle — reaches the trigger, anyone (typically a keeper) can call `executeProtection`, which repays part of the
/// user's Morpho debt using only that user's reserve for that market.
///
/// Security properties:
/// - No admin, no owner, no upgradeability: nobody can move a user's reserve except (a) the user via
///   `withdrawReserve` (always to `msg.sender`) and (b) `executeProtection`, which can only send it to Morpho as a
///   repayment of that same user's debt in that same market.
/// - Reserves are keyed by (user, market id). The market id commits to the loan token, so one market's reserve can
///   never be used for another token or another user.
/// - Execution is condition-gated (enabled policy, cooldown, LTV >= trigger) and bounded (one position, capped amount).
/// - Exact, single-use allowances to Morpho; all state-changing entry points are `nonReentrant`.
contract RWASafetyGuard is IRWASafetyGuard, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;
    using SharesMathLib for uint256;
    using MathLib for uint256;

    /// @notice Upper bound for a policy cooldown.
    uint256 public constant MAX_COOLDOWN = 30 days;

    /// @notice The Morpho Blue singleton.
    IMorpho public immutable MORPHO;

    /// @notice Sum of all user reserves per loan token (for transparency / invariant checks).
    mapping(address token => uint256) public totalReserves;

    /// @notice Whether (user, id) is listed in the protected-positions registry used by keepers.
    mapping(address user => mapping(Id id => bool)) public isRegistered;

    mapping(address user => mapping(Id id => ProtectionPolicy)) internal _policies;
    mapping(address user => mapping(Id id => uint256)) internal _reserves;
    ProtectedPosition[] internal _protectedPositions;

    /// @dev Position + market state needed for the protection math.
    struct Snapshot {
        uint256 collateral;
        uint256 borrowShares;
        uint256 totalBorrowAssets;
        uint256 totalBorrowShares;
        uint256 price;
    }

    /// @dev Result of the protection math.
    struct Calc {
        uint256 debt;
        uint256 collateralValue;
        uint256 ltv;
        uint256 requiredRepay;
        uint256 repayAmount;
        uint256 expectedDebtAfter;
        uint256 expectedLtvAfter;
        bool targetReachable;
        bool fullRepay;
    }

    constructor(address morpho) {
        if (morpho == address(0)) revert ZeroAddress();
        MORPHO = IMorpho(morpho);
    }

    /* ───────────────────────────── USER ACTIONS ───────────────────────────── */

    /// @inheritdoc IRWASafetyGuard
    function setProtectionPolicy(
        MarketParams calldata marketParams,
        uint256 triggerLtv,
        uint256 targetLtv,
        uint256 maxRepayPerExecution,
        uint256 cooldown,
        bool enabled
    ) external nonReentrant {
        Id id = marketParams.id();
        _requireMarketCreated(id);

        uint256 lltv = marketParams.lltv;
        if (lltv == 0 || lltv >= WAD) revert InvalidLltv();
        // The trigger must fire strictly before Morpho would allow liquidation.
        if (triggerLtv == 0 || triggerLtv >= lltv) revert InvalidTriggerLtv(triggerLtv, lltv);
        if (targetLtv == 0 || targetLtv >= triggerLtv) revert InvalidTargetLtv(targetLtv, triggerLtv);
        if (maxRepayPerExecution == 0 || maxRepayPerExecution > type(uint128).max) revert InvalidMaxRepay();
        if (cooldown > MAX_COOLDOWN) revert InvalidCooldown(cooldown, MAX_COOLDOWN);

        // Casts are safe: targetLtv < triggerLtv < lltv < 1e18 < 2^64, cooldown <= 30 days < 2^32, and
        // maxRepayPerExecution was checked against type(uint128).max above.
        ProtectionPolicy storage policy = _policies[msg.sender][id];
        policy.enabled = enabled;
        // forge-lint: disable-next-line(unsafe-typecast)
        policy.triggerLtv = uint64(triggerLtv);
        // forge-lint: disable-next-line(unsafe-typecast)
        policy.targetLtv = uint64(targetLtv);
        // forge-lint: disable-next-line(unsafe-typecast)
        policy.cooldown = uint32(cooldown);
        // forge-lint: disable-next-line(unsafe-typecast)
        policy.maxRepayPerExecution = uint128(maxRepayPerExecution);

        if (!isRegistered[msg.sender][id]) {
            isRegistered[msg.sender][id] = true;
            _protectedPositions.push(ProtectedPosition({user: msg.sender, id: id}));
        }

        emit ProtectionConfigured(msg.sender, id, enabled, triggerLtv, targetLtv, maxRepayPerExecution, cooldown);
    }

    /// @inheritdoc IRWASafetyGuard
    function disableProtection(MarketParams calldata marketParams) external nonReentrant {
        Id id = marketParams.id();
        ProtectionPolicy storage policy = _policies[msg.sender][id];
        policy.enabled = false;
        emit ProtectionConfigured(
            msg.sender, id, false, policy.triggerLtv, policy.targetLtv, policy.maxRepayPerExecution, policy.cooldown
        );
    }

    /// @inheritdoc IRWASafetyGuard
    function depositReserve(MarketParams calldata marketParams, uint256 assets)
        external
        nonReentrant
        returns (uint256 credited)
    {
        if (assets == 0) revert ZeroAmount();
        Id id = marketParams.id();
        _requireMarketCreated(id);

        IERC20 token = IERC20(marketParams.loanToken);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), assets);
        // Credit what was actually received (defensive against fee-on-transfer tokens).
        credited = token.balanceOf(address(this)) - balanceBefore;
        if (credited == 0) revert ZeroAmount();

        uint256 newReserve = _reserves[msg.sender][id] + credited;
        _reserves[msg.sender][id] = newReserve;
        totalReserves[address(token)] += credited;

        emit ReserveDeposited(msg.sender, id, address(token), credited, newReserve);
    }

    /// @inheritdoc IRWASafetyGuard
    /// @dev Pass `type(uint256).max` to withdraw the full reserve. Funds always go to `msg.sender`.
    function withdrawReserve(MarketParams calldata marketParams, uint256 assets)
        external
        nonReentrant
        returns (uint256 withdrawn)
    {
        Id id = marketParams.id();
        uint256 reserve = _reserves[msg.sender][id];
        withdrawn = assets == type(uint256).max ? reserve : assets;
        if (withdrawn == 0) revert ZeroAmount();
        if (withdrawn > reserve) revert InsufficientReserve(withdrawn, reserve);

        uint256 newReserve = reserve - withdrawn;
        _reserves[msg.sender][id] = newReserve;
        totalReserves[marketParams.loanToken] -= withdrawn;

        IERC20(marketParams.loanToken).safeTransfer(msg.sender, withdrawn);

        emit ReserveWithdrawn(msg.sender, id, marketParams.loanToken, withdrawn, newReserve);
    }

    /* ───────────────────────────── KEEPER ACTION ───────────────────────────── */

    /// @inheritdoc IRWASafetyGuard
    /// @dev Permissionless: the conditions, the amount and the beneficiary are fully determined on-chain, so the
    /// caller cannot redirect funds. Reverts unless the position is at or above the user's trigger LTV.
    function executeProtection(MarketParams calldata marketParams, address user)
        external
        nonReentrant
        returns (uint256 assetsRepaid, uint256 sharesRepaid)
    {
        if (user == address(0)) revert ZeroAddress();
        Id id = marketParams.id();
        ProtectionPolicy storage policy = _policies[user][id];
        if (!policy.enabled) revert ProtectionDisabled();
        uint256 nextTime = _nextExecutionTime(policy);
        if (block.timestamp < nextTime) revert CooldownActive(nextTime);
        _requireMarketCreated(id);

        // 1. Bring Morpho's accounting up to date so the debt we read includes all accrued interest.
        MORPHO.accrueInterest(marketParams);

        // 2. Read the latest on-chain state and compute the repayment.
        Snapshot memory s = _snapshot(id, user);
        s.price = _readPrice(marketParams.oracle);
        uint256 reserve = _reserves[user][id];
        Calc memory c = _calculate(policy, reserve, s);

        if (c.debt == 0) revert NoDebt();
        if (c.ltv < policy.triggerLtv) revert PositionHealthy(c.ltv, policy.triggerLtv);
        if (c.repayAmount == 0) revert InsufficientReserve(c.requiredRepay, reserve);

        // 3. Effects before interactions.
        _reserves[user][id] = reserve - c.repayAmount;
        totalReserves[marketParams.loanToken] -= c.repayAmount;
        // forge-lint: disable-next-line(unsafe-typecast)
        policy.lastExecutedAt = uint64(block.timestamp); // safe until year 584,942,417,355

        // 4. Repay on Morpho on behalf of `user`, with an exact single-use allowance.
        (assetsRepaid, sharesRepaid) = _repayOnMorpho(marketParams, user, c, s.borrowShares);

        // 5. Re-read the position and prove the debt went down.
        Snapshot memory post = _snapshot(id, user);
        uint256 debtAfter = post.borrowShares.toAssetsUp(post.totalBorrowAssets, post.totalBorrowShares);
        if (debtAfter >= c.debt) revert DebtNotReduced(c.debt, debtAfter);

        _emitExecuted(user, id, assetsRepaid, sharesRepaid, c, debtAfter, reserve - c.repayAmount, policy.targetLtv);
    }

    /* ───────────────────────────── VIEWS ───────────────────────────── */

    /// @inheritdoc IRWASafetyGuard
    function getProtectionPolicy(address user, Id id) external view returns (ProtectionPolicy memory) {
        return _policies[user][id];
    }

    /// @inheritdoc IRWASafetyGuard
    function reserveOf(address user, Id id) external view returns (uint256) {
        return _reserves[user][id];
    }

    /// @notice Convenience helper returning the Morpho market id of `marketParams`.
    function marketId(MarketParams calldata marketParams) external pure returns (Id) {
        return marketParams.id();
    }

    /// @inheritdoc IRWASafetyGuard
    /// @dev Uses Morpho's view-side interest accrual (MorphoBalancesLib), so `debt` is up to date without a tx.
    /// If the oracle reverts or returns 0, price-dependent fields are 0 and `healthy` is false when there is debt.
    function getPositionRisk(MarketParams calldata marketParams, address user)
        public
        view
        returns (PositionRisk memory risk)
    {
        Id id = marketParams.id();
        _requireMarketCreated(id);
        Snapshot memory s = _expectedSnapshot(marketParams, id, user);
        (, s.price) = _tryReadPrice(marketParams.oracle);

        risk.collateral = s.collateral;
        risk.oraclePrice = s.price;
        risk.collateralValue = s.collateral.mulDivDown(s.price, ORACLE_PRICE_SCALE);
        risk.borrowShares = s.borrowShares;
        risk.debt = s.borrowShares.toAssetsUp(s.totalBorrowAssets, s.totalBorrowShares);
        risk.ltv = _ltv(risk.debt, risk.collateralValue);
        risk.lltv = marketParams.lltv;
        risk.maxBorrow = risk.collateralValue.wMulDown(marketParams.lltv);
        risk.reserve = _reserves[user][id];
        risk.healthy = risk.maxBorrow >= risk.debt;

        if (risk.debt != 0 && s.collateral != 0) {
            risk.liquidationPrice = _priceAtLtv(risk.debt, s.collateral, marketParams.lltv);
            uint256 trigger = _policies[user][id].triggerLtv;
            if (trigger != 0) risk.triggerPrice = _priceAtLtv(risk.debt, s.collateral, trigger);
        }
        if (risk.debt == 0) risk.priceDropToLiquidation = WAD;
        else if (risk.ltv < marketParams.lltv) risk.priceDropToLiquidation = WAD - risk.ltv.wDivUp(marketParams.lltv);
    }

    /// @inheritdoc IRWASafetyGuard
    function previewProtection(MarketParams calldata marketParams, address user)
        public
        view
        returns (ProtectionPreview memory)
    {
        (, uint256 price) = _tryReadPrice(marketParams.oracle);
        return _preview(marketParams, user, price);
    }

    /// @inheritdoc IRWASafetyGuard
    /// @dev For "what-if" simulations: same math as `executeProtection`, at a hypothetical oracle price.
    function previewProtectionAtPrice(MarketParams calldata marketParams, address user, uint256 oraclePrice)
        external
        view
        returns (ProtectionPreview memory)
    {
        return _preview(marketParams, user, oraclePrice);
    }

    /// @notice Risk, policy and preview in a single call (for dashboards).
    function getDashboard(MarketParams calldata marketParams, address user)
        external
        view
        returns (PositionRisk memory risk, ProtectionPolicy memory policy, ProtectionPreview memory preview)
    {
        risk = getPositionRisk(marketParams, user);
        policy = _policies[user][marketParams.id()];
        preview = previewProtection(marketParams, user);
    }

    /// @inheritdoc IRWASafetyGuard
    function protectedPositionsCount() external view returns (uint256) {
        return _protectedPositions.length;
    }

    /// @inheritdoc IRWASafetyGuard
    function getProtectedPositions(uint256 offset, uint256 limit)
        external
        view
        returns (ProtectedPosition[] memory page)
    {
        uint256 len = _protectedPositions.length;
        if (offset >= len) return new ProtectedPosition[](0);
        uint256 n = UtilsLib.min(limit, len - offset);
        page = new ProtectedPosition[](n);
        for (uint256 i; i < n; ++i) {
            page[i] = _protectedPositions[offset + i];
        }
    }

    /* ───────────────────────────── INTERNAL ───────────────────────────── */

    function _preview(MarketParams calldata marketParams, address user, uint256 price)
        internal
        view
        returns (ProtectionPreview memory p)
    {
        Id id = marketParams.id();
        _requireMarketCreated(id);
        ProtectionPolicy memory policy = _policies[user][id];
        uint256 reserve = _reserves[user][id];
        Snapshot memory s = _expectedSnapshot(marketParams, id, user);
        s.price = price;
        Calc memory c = _calculate(policy, reserve, s);

        p.debt = c.debt;
        p.collateralValue = c.collateralValue;
        p.currentLtv = c.ltv;
        p.requiredRepay = c.requiredRepay;
        p.repayAmount = c.repayAmount;
        p.expectedDebtAfter = c.expectedDebtAfter;
        p.expectedLtvAfter = c.expectedLtvAfter;
        p.reserveAfter = reserve - c.repayAmount;
        p.targetReachable = c.targetReachable;
        p.nextExecutionTime = _nextExecutionTime(policy);

        if (price == 0) p.status = PreviewStatus.InvalidPrice;
        else if (!policy.enabled) p.status = PreviewStatus.PolicyDisabled;
        else if (c.debt == 0) p.status = PreviewStatus.NoDebt;
        else if (c.ltv < policy.triggerLtv) p.status = PreviewStatus.BelowTrigger;
        else if (block.timestamp < p.nextExecutionTime) p.status = PreviewStatus.CooldownActive;
        else if (c.repayAmount == 0) p.status = PreviewStatus.NoReserve;
        else p.status = PreviewStatus.Executable;
        p.executable = p.status == PreviewStatus.Executable;
    }

    /// @dev Core protection math, shared by previews and execution.
    function _calculate(ProtectionPolicy memory policy, uint256 reserve, Snapshot memory s)
        internal
        pure
        returns (Calc memory c)
    {
        c.debt = s.borrowShares.toAssetsUp(s.totalBorrowAssets, s.totalBorrowShares);
        c.collateralValue = s.collateral.mulDivDown(s.price, ORACLE_PRICE_SCALE);
        c.ltv = _ltv(c.debt, c.collateralValue);
        if (c.debt == 0) {
            c.targetReachable = true;
            return c;
        }

        uint256 targetDebt = c.collateralValue.wMulDown(policy.targetLtv);
        if (c.debt > targetDebt) {
            // Morpho.repay burns `assets.toSharesDown(...)` shares, so the remaining debt (rounded up) can exceed
            // `debt - assets` by up to one share's worth of assets. Over-repay by that margin (+1 wei) so that the
            // post-execution LTV never ends above the target.
            uint256 margin = uint256(1).toAssetsUp(s.totalBorrowAssets, s.totalBorrowShares) + 1;
            c.requiredRepay = UtilsLib.min(c.debt, c.debt - targetDebt + margin);
        }

        c.repayAmount = UtilsLib.min(c.requiredRepay, UtilsLib.min(reserve, policy.maxRepayPerExecution));
        c.targetReachable = c.repayAmount >= c.requiredRepay;
        c.fullRepay = c.repayAmount == c.debt;

        if (!c.fullRepay) {
            // Exact replica of Morpho.repay's share accounting.
            uint256 burned = c.repayAmount.toSharesDown(s.totalBorrowAssets, s.totalBorrowShares);
            c.expectedDebtAfter = (s.borrowShares - burned)
            .toAssetsUp(UtilsLib.zeroFloorSub(s.totalBorrowAssets, c.repayAmount), s.totalBorrowShares - burned);
        }
        c.expectedLtvAfter = _ltv(c.expectedDebtAfter, c.collateralValue);
    }

    function _repayOnMorpho(MarketParams calldata marketParams, address user, Calc memory c, uint256 borrowShares)
        internal
        returns (uint256 assetsRepaid, uint256 sharesRepaid)
    {
        IERC20 loanToken = IERC20(marketParams.loanToken);
        loanToken.forceApprove(address(MORPHO), c.repayAmount);
        if (c.fullRepay) {
            // Repaying by shares clears the position exactly (no dust, no underflow on rounding).
            (assetsRepaid, sharesRepaid) = MORPHO.repay(marketParams, 0, borrowShares, user, "");
        } else {
            (assetsRepaid, sharesRepaid) = MORPHO.repay(marketParams, c.repayAmount, 0, user, "");
        }
        if (assetsRepaid != c.repayAmount) revert UnexpectedRepayAmount(c.repayAmount, assetsRepaid);
        // Morpho pulls exactly `assetsRepaid`; make sure no allowance is ever left behind.
        if (loanToken.allowance(address(this), address(MORPHO)) != 0) loanToken.forceApprove(address(MORPHO), 0);
    }

    function _emitExecuted(
        address user,
        Id id,
        uint256 assetsRepaid,
        uint256 sharesRepaid,
        Calc memory c,
        uint256 debtAfter,
        uint256 reserveAfter,
        uint256 targetLtv
    ) internal {
        uint256 ltvAfter = _ltv(debtAfter, c.collateralValue);
        emit ProtectionExecuted(
            user,
            id,
            msg.sender,
            assetsRepaid,
            sharesRepaid,
            c.debt,
            debtAfter,
            c.ltv,
            ltvAfter,
            reserveAfter,
            // Only report the target as reached if the reserve/cap allowed it AND the post-state confirms it.
            c.targetReachable && ltvAfter <= targetLtv
        );
    }

    /// @dev Current on-chain state (call after `accrueInterest`).
    function _snapshot(Id id, address user) internal view returns (Snapshot memory s) {
        Position memory pos = MORPHO.position(id, user);
        Market memory m = MORPHO.market(id);
        s.collateral = pos.collateral;
        s.borrowShares = pos.borrowShares;
        s.totalBorrowAssets = m.totalBorrowAssets;
        s.totalBorrowShares = m.totalBorrowShares;
    }

    /// @dev State including interest that would accrue if `accrueInterest` were called now (view-only).
    function _expectedSnapshot(MarketParams calldata marketParams, Id id, address user)
        internal
        view
        returns (Snapshot memory s)
    {
        Position memory pos = MORPHO.position(id, user);
        (,, uint256 totalBorrowAssets, uint256 totalBorrowShares) = MORPHO.expectedMarketBalances(marketParams);
        s.collateral = pos.collateral;
        s.borrowShares = pos.borrowShares;
        s.totalBorrowAssets = totalBorrowAssets;
        s.totalBorrowShares = totalBorrowShares;
    }

    function _readPrice(address oracle) internal view returns (uint256 price) {
        price = IOracle(oracle).price();
        if (price == 0) revert InvalidOraclePrice();
    }

    function _tryReadPrice(address oracle) internal view returns (bool ok, uint256 price) {
        try IOracle(oracle).price() returns (uint256 p) {
            return (p != 0, p);
        } catch {
            return (false, 0);
        }
    }

    function _requireMarketCreated(Id id) internal view {
        if (MORPHO.market(id).lastUpdate == 0) revert MarketNotCreated();
    }

    function _nextExecutionTime(ProtectionPolicy memory policy) internal pure returns (uint256) {
        if (policy.lastExecutedAt == 0 || policy.cooldown == 0) return 0;
        return uint256(policy.lastExecutedAt) + policy.cooldown;
    }

    /// @dev LTV = debt / collateralValue (WAD), rounded up (conservative).
    function _ltv(uint256 debt, uint256 collateralValue) internal pure returns (uint256) {
        if (debt == 0) return 0;
        if (collateralValue == 0) return type(uint256).max;
        return debt.wDivUp(collateralValue);
    }

    /// @dev Oracle price at which `debt / (collateral * price / 1e36) == ltv`.
    function _priceAtLtv(uint256 debt, uint256 collateral, uint256 ltv) internal pure returns (uint256) {
        return debt.wDivUp(ltv).mulDivUp(ORACLE_PRICE_SCALE, collateral);
    }
}
