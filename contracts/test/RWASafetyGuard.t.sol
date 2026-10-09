// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMorpho, Id, MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

import {BaseTest} from "./BaseTest.sol";
import {SettableOracle, ToggleRevertOracle, ReentrantToken} from "./utils/TestHelpers.sol";
import {RWASafetyGuard} from "../src/RWASafetyGuard.sol";
import {
    IRWASafetyGuard,
    ProtectionPolicy,
    PositionRisk,
    PreviewStatus,
    ProtectionPreview,
    ProtectedPosition
} from "../src/interfaces/IRWASafetyGuard.sol";
import {MockRWAOracle} from "../src/mocks/MockRWAOracle.sol";

contract RWASafetyGuardTest is BaseTest {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    bytes32 internal constant EXECUTED_SIG = keccak256(
        "ProtectionExecuted(address,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)"
    );

    /// @dev Non-indexed fields of ProtectionExecuted, in order (a static struct ABI-decodes like its fields).
    struct Executed {
        uint256 assetsRepaid;
        uint256 sharesRepaid;
        uint256 debtBefore;
        uint256 debtAfter;
        uint256 ltvBefore;
        uint256 ltvAfter;
        uint256 reserveAfter;
        bool targetReached;
    }

    address internal lastExecutedUser;
    Id internal lastExecutedId;
    address internal lastExecutor;

    function _executeAndDecode(MarketParams memory params, address user) internal returns (Executed memory e) {
        vm.recordLogs();
        vm.prank(KEEPER);
        guard.executeProtection(params, user);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(guard) && logs[i].topics[0] == EXECUTED_SIG) {
                lastExecutedUser = address(uint160(uint256(logs[i].topics[1])));
                lastExecutedId = Id.wrap(logs[i].topics[2]);
                lastExecutor = address(uint160(uint256(logs[i].topics[3])));
                return abi.decode(logs[i].data, (Executed));
            }
        }
        revert("ProtectionExecuted not emitted");
    }

    /* ═════════════════════ P0: the hackathon scenario ═════════════════════ */

    function test_DemoScenario_EndToEnd() public {
        // Steps 2-5: $2,000 collateral, $1,200 debt, 200 mUSDC reserve, trigger 70% / target 65%.
        _demoSetup();
        PositionRisk memory risk = guard.getPositionRisk(mp, ALICE);
        assertEq(risk.collateralValue, 2000e6, "collateral value $2,000");
        assertEq(risk.debt, 1200e6, "debt $1,200");
        assertEq(risk.ltv, 0.6e18, "initial LTV 60%");
        assertEq(risk.lltv, LLTV);
        assertEq(risk.reserve, RESERVE);
        assertTrue(risk.healthy);

        ProtectionPreview memory pre = guard.previewProtection(mp, ALICE);
        assertFalse(pre.executable);
        assertEq(uint8(pre.status), uint8(PreviewStatus.BelowTrigger));
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.PositionHealthy.selector, 0.6e18, TRIGGER));
        guard.executeProtection(mp, ALICE);

        // Step 6-7: 20% price decline => collateral $1,600, LTV 75%.
        _crash(2000);
        risk = guard.getPositionRisk(mp, ALICE);
        assertEq(risk.collateralValue, 1600e6, "collateral value $1,600");
        assertEq(risk.ltv, 0.75e18, "LTV 75%");
        assertTrue(risk.healthy, "still below LLTV 77%");

        pre = guard.previewProtection(mp, ALICE);
        assertTrue(pre.executable);
        assertTrue(pre.targetReachable);
        assertApproxEqAbs(pre.repayAmount, 160e6, 10, "expected repayment 160 mUSDC");

        uint256 sharesBefore = _borrowShares(id, ALICE);
        uint256 guardBalBefore = usdc.balanceOf(address(guard));
        uint256 morphoBalBefore = usdc.balanceOf(address(morpho));
        uint256 keeperBalBefore = usdc.balanceOf(KEEPER);
        Market memory mBefore = morpho.market(id);

        // Step 8: execute protection (real on-chain repay through Morpho Blue).
        Executed memory e = _executeAndDecode(mp, ALICE);

        // Step 9-11: verify debt reduction, LTV, event, and Morpho/ERC-20 state.
        assertEq(lastExecutedUser, ALICE);
        assertEq(Id.unwrap(lastExecutedId), Id.unwrap(id));
        assertEq(lastExecutor, KEEPER);
        assertEq(e.assetsRepaid, pre.repayAmount, "preview matches execution");
        assertApproxEqAbs(e.assetsRepaid, 160e6, 10);
        assertEq(e.debtBefore, 1200e6);
        assertApproxEqAbs(e.debtAfter, 1040e6, 10, "debt ~ $1,040");
        assertEq(e.debtAfter, pre.expectedDebtAfter, "exact share-math simulation");
        assertEq(e.ltvBefore, 0.75e18);
        assertLe(e.ltvAfter, TARGET, "LTV <= 65%");
        assertApproxEqAbs(e.ltvAfter, TARGET, 1e12, "LTV ~ 65%");
        assertApproxEqAbs(e.reserveAfter, 40e6, 10);
        assertTrue(e.targetReached);

        assertEq(_debtOf(mp, ALICE), e.debtAfter, "Morpho debt matches event");
        assertEq(sharesBefore - _borrowShares(id, ALICE), e.sharesRepaid, "borrow shares burned");
        Market memory mAfter = morpho.market(id);
        assertEq(mBefore.totalBorrowAssets - mAfter.totalBorrowAssets, e.assetsRepaid, "total borrow decreased");
        assertEq(mBefore.totalBorrowShares - mAfter.totalBorrowShares, e.sharesRepaid);
        assertEq(guardBalBefore - usdc.balanceOf(address(guard)), e.assetsRepaid, "guard paid");
        assertEq(usdc.balanceOf(address(morpho)) - morphoBalBefore, e.assetsRepaid, "Morpho received");
        assertEq(usdc.balanceOf(KEEPER), keeperBalBefore, "keeper received nothing");
        assertEq(usdc.allowance(address(guard), address(morpho)), 0, "no leftover allowance");
        assertEq(guard.reserveOf(ALICE, id), e.reserveAfter);
        assertEq(guard.totalReserves(address(usdc)), usdc.balanceOf(address(guard)));
        assertEq(guard.getProtectionPolicy(ALICE, id).lastExecutedAt, block.timestamp);
    }

    function test_DemoScenario_WithAccruedInterest() public {
        _demoSetup();
        skip(7 days);
        _crash(2000);
        uint256 accrued = _debtOf(mp, ALICE);
        assertGt(accrued, BORROW, "interest accrued");

        Executed memory e = _executeAndDecode(mp, ALICE);
        assertEq(e.debtBefore, accrued, "execution uses interest-accrued debt");
        assertLe(e.ltvAfter, TARGET);
        assertApproxEqAbs(e.ltvAfter, TARGET, 1e12);
        assertGt(e.assetsRepaid, 160e6, "interest increases the repayment");
    }

    /* ═════════════════════ reserves ═════════════════════ */

    function test_DepositReserve() public {
        _mintUsdc(ALICE, 300e6);
        vm.startPrank(ALICE);
        usdc.approve(address(guard), 300e6);
        vm.expectEmit(address(guard));
        emit IRWASafetyGuard.ReserveDeposited(ALICE, id, address(usdc), 300e6, 300e6);
        uint256 credited = guard.depositReserve(mp, 300e6);
        vm.stopPrank();

        assertEq(credited, 300e6);
        assertEq(guard.reserveOf(ALICE, id), 300e6);
        assertEq(guard.totalReserves(address(usdc)), 300e6);
        assertEq(usdc.balanceOf(address(guard)), 300e6);
        assertEq(usdc.balanceOf(ALICE), 0);
    }

    function test_WithdrawReserve_PartialAndMax() public {
        _deposit(ALICE, mp, 300e6);

        vm.prank(ALICE);
        vm.expectEmit(address(guard));
        emit IRWASafetyGuard.ReserveWithdrawn(ALICE, id, address(usdc), 100e6, 200e6);
        guard.withdrawReserve(mp, 100e6);
        assertEq(guard.reserveOf(ALICE, id), 200e6);
        assertEq(usdc.balanceOf(ALICE), 100e6);

        vm.prank(ALICE);
        uint256 withdrawn = guard.withdrawReserve(mp, type(uint256).max);
        assertEq(withdrawn, 200e6);
        assertEq(guard.reserveOf(ALICE, id), 0);
        assertEq(usdc.balanceOf(ALICE), 300e6);
        assertEq(guard.totalReserves(address(usdc)), 0);
    }

    function test_RevertWhen_WithdrawMoreThanReserve() public {
        _deposit(ALICE, mp, 100e6);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InsufficientReserve.selector, 100e6 + 1, 100e6));
        guard.withdrawReserve(mp, 100e6 + 1);
    }

    function test_RevertWhen_ZeroAmounts() public {
        vm.prank(ALICE);
        vm.expectRevert(IRWASafetyGuard.ZeroAmount.selector);
        guard.depositReserve(mp, 0);

        vm.prank(ALICE);
        vm.expectRevert(IRWASafetyGuard.ZeroAmount.selector);
        guard.withdrawReserve(mp, 0);

        vm.prank(ALICE); // max withdraw of an empty reserve
        vm.expectRevert(IRWASafetyGuard.ZeroAmount.selector);
        guard.withdrawReserve(mp, type(uint256).max);
    }

    function test_RevertWhen_DepositToUncreatedMarket() public {
        MarketParams memory fake = mp;
        fake.lltv = 0.5e18; // different id, never created
        _mintUsdc(ALICE, 1e6);
        vm.startPrank(ALICE);
        usdc.approve(address(guard), 1e6);
        vm.expectRevert(IRWASafetyGuard.MarketNotCreated.selector);
        guard.depositReserve(fake, 1e6);
        vm.stopPrank();
    }

    function test_ReservesAreIndependentPerUser() public {
        // Both users borrow in the same market; only ALICE funds a reserve.
        _demoSetup();
        _openPosition(BOB, mp, COLLATERAL, BORROW);
        _setPolicy(BOB, mp, MAX_REPAY, 0);
        _deposit(BOB, mp, 1e6); // BOB's reserve is tiny

        _crash(2000);

        // BOB's protection can only use BOB's 1 mUSDC, never ALICE's 200.
        Executed memory eb = _executeAndDecode(mp, BOB);
        assertEq(eb.assetsRepaid, 1e6);
        assertFalse(eb.targetReached);
        assertEq(guard.reserveOf(BOB, id), 0);
        assertEq(guard.reserveOf(ALICE, id), RESERVE, "ALICE untouched");

        // BOB's reserve is now empty: further execution reverts instead of touching ALICE's funds.
        uint256 required = guard.previewProtection(mp, BOB).requiredRepay;
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InsufficientReserve.selector, required, 0));
        guard.executeProtection(mp, BOB);

        // BOB cannot withdraw ALICE's reserve.
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InsufficientReserve.selector, 1, 0));
        guard.withdrawReserve(mp, 1);

        // ALICE's execution uses exactly her reserve.
        Executed memory ea = _executeAndDecode(mp, ALICE);
        assertEq(guard.reserveOf(ALICE, id), RESERVE - ea.assetsRepaid);
        assertEq(guard.totalReserves(address(usdc)), usdc.balanceOf(address(guard)));
    }

    function test_ReservesAreIndependentPerMarket() public {
        _demoSetup();
        vm.prank(BOB);
        (MarketParams memory mpB, Id idB) = factory.createDemoMarket(0);
        _deposit(ALICE, mpB, 50e6);
        assertEq(guard.reserveOf(ALICE, id), RESERVE);
        assertEq(guard.reserveOf(ALICE, idB), 50e6);

        _crash(2000);
        _executeAndDecode(mp, ALICE);
        assertEq(guard.reserveOf(ALICE, idB), 50e6, "other market's reserve untouched");
    }

    /* ═════════════════════ policy validation ═════════════════════ */

    function test_SetProtectionPolicy_StoresAndEmits() public {
        vm.prank(ALICE);
        vm.expectEmit(address(guard));
        emit IRWASafetyGuard.ProtectionConfigured(ALICE, id, true, TRIGGER, TARGET, MAX_REPAY, 1 hours);
        guard.setProtectionPolicy(mp, TRIGGER, TARGET, MAX_REPAY, 1 hours, true);

        ProtectionPolicy memory p = guard.getProtectionPolicy(ALICE, id);
        assertTrue(p.enabled);
        assertEq(p.triggerLtv, TRIGGER);
        assertEq(p.targetLtv, TARGET);
        assertEq(p.maxRepayPerExecution, MAX_REPAY);
        assertEq(p.cooldown, 1 hours);
        assertEq(p.lastExecutedAt, 0);

        // Update keeps a single registry entry.
        vm.prank(ALICE);
        guard.setProtectionPolicy(mp, 0.72e18, 0.6e18, 100e6, 0, true);
        assertEq(guard.protectedPositionsCount(), 1);
        p = guard.getProtectionPolicy(ALICE, id);
        assertEq(p.triggerLtv, 0.72e18);
        assertEq(p.targetLtv, 0.6e18);
    }

    function test_RevertWhen_TriggerNotBelowLltv() public {
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InvalidTriggerLtv.selector, LLTV, LLTV));
        guard.setProtectionPolicy(mp, LLTV, TARGET, MAX_REPAY, 0, true);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InvalidTriggerLtv.selector, 0.9e18, LLTV));
        guard.setProtectionPolicy(mp, 0.9e18, TARGET, MAX_REPAY, 0, true);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InvalidTriggerLtv.selector, 0, LLTV));
        guard.setProtectionPolicy(mp, 0, 0, MAX_REPAY, 0, true);
        vm.stopPrank();
    }

    function test_RevertWhen_TargetNotBelowTrigger() public {
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InvalidTargetLtv.selector, TRIGGER, TRIGGER));
        guard.setProtectionPolicy(mp, TRIGGER, TRIGGER, MAX_REPAY, 0, true);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InvalidTargetLtv.selector, 0.71e18, TRIGGER));
        guard.setProtectionPolicy(mp, TRIGGER, 0.71e18, MAX_REPAY, 0, true);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InvalidTargetLtv.selector, 0, TRIGGER));
        guard.setProtectionPolicy(mp, TRIGGER, 0, MAX_REPAY, 0, true);
        vm.stopPrank();
    }

    function test_RevertWhen_InvalidMaxRepayOrCooldown() public {
        vm.startPrank(ALICE);
        vm.expectRevert(IRWASafetyGuard.InvalidMaxRepay.selector);
        guard.setProtectionPolicy(mp, TRIGGER, TARGET, 0, 0, true);
        vm.expectRevert(IRWASafetyGuard.InvalidMaxRepay.selector);
        guard.setProtectionPolicy(mp, TRIGGER, TARGET, uint256(type(uint128).max) + 1, 0, true);
        uint256 maxCooldown = guard.MAX_COOLDOWN();
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InvalidCooldown.selector, maxCooldown + 1, maxCooldown));
        guard.setProtectionPolicy(mp, TRIGGER, TARGET, MAX_REPAY, maxCooldown + 1, true);
        vm.stopPrank();
    }

    function test_RevertWhen_PolicyOnUncreatedMarket() public {
        MarketParams memory fake = mp;
        fake.oracle = address(0xdead);
        vm.prank(ALICE);
        vm.expectRevert(IRWASafetyGuard.MarketNotCreated.selector);
        guard.setProtectionPolicy(fake, TRIGGER, TARGET, MAX_REPAY, 0, true);
    }

    function test_DisableAndReenableProtection() public {
        _demoSetup();
        _crash(2000);

        vm.prank(ALICE);
        guard.disableProtection(mp);
        assertFalse(guard.getProtectionPolicy(ALICE, id).enabled);
        assertEq(uint8(guard.previewProtection(mp, ALICE).status), uint8(PreviewStatus.PolicyDisabled));

        vm.prank(KEEPER);
        vm.expectRevert(IRWASafetyGuard.ProtectionDisabled.selector);
        guard.executeProtection(mp, ALICE);

        _setPolicy(ALICE, mp, MAX_REPAY, 0);
        _executeAndDecode(mp, ALICE);
    }

    /* ═════════════════════ execution rules ═════════════════════ */

    function test_RevertWhen_PositionHealthy() public {
        _demoSetup();
        _crash(500); // -5% => LTV 63.2%
        uint256 ltv = guard.getPositionRisk(mp, ALICE).ltv;
        assertLt(ltv, TRIGGER);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.PositionHealthy.selector, ltv, TRIGGER));
        guard.executeProtection(mp, ALICE);
    }

    function test_RevertWhen_NoDebt() public {
        _deposit(ALICE, mp, RESERVE);
        _setPolicy(ALICE, mp, MAX_REPAY, 0);
        assertEq(uint8(guard.previewProtection(mp, ALICE).status), uint8(PreviewStatus.NoDebt));
        vm.prank(KEEPER);
        vm.expectRevert(IRWASafetyGuard.NoDebt.selector);
        guard.executeProtection(mp, ALICE);
    }

    function test_InsufficientReserve_PartialProtection() public {
        _openPosition(ALICE, mp, COLLATERAL, BORROW);
        _deposit(ALICE, mp, 100e6); // less than the 160 needed
        _setPolicy(ALICE, mp, MAX_REPAY, 0);
        _crash(2000);

        ProtectionPreview memory pre = guard.previewProtection(mp, ALICE);
        assertTrue(pre.executable);
        assertFalse(pre.targetReachable, "preview flags the shortfall");
        assertEq(pre.repayAmount, 100e6);

        Executed memory e = _executeAndDecode(mp, ALICE);
        assertEq(e.assetsRepaid, 100e6);
        assertFalse(e.targetReached, "not reported as fully protected");
        assertEq(e.reserveAfter, 0);
        assertApproxEqAbs(e.debtAfter, 1100e6, 1);
        assertGt(e.ltvAfter, TARGET);
        // 1100 / 1600 = 68.75%: below the trigger again, so no further execution.
        assertEq(uint8(guard.previewProtection(mp, ALICE).status), uint8(PreviewStatus.BelowTrigger));
    }

    function test_RevertWhen_ReserveEmptyAboveTrigger() public {
        _openPosition(ALICE, mp, COLLATERAL, BORROW);
        _deposit(ALICE, mp, 100e6);
        _setPolicy(ALICE, mp, MAX_REPAY, 0);
        _crash(3000); // -30% => LTV 85.7% (above LLTV: liquidatable)
        assertFalse(guard.getPositionRisk(mp, ALICE).healthy);

        Executed memory e = _executeAndDecode(mp, ALICE);
        assertEq(e.assetsRepaid, 100e6);
        assertFalse(e.targetReached);
        assertGt(e.ltvAfter, TRIGGER, "still at risk");

        ProtectionPreview memory pre = guard.previewProtection(mp, ALICE);
        assertEq(uint8(pre.status), uint8(PreviewStatus.NoReserve));
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.InsufficientReserve.selector, pre.requiredRepay, 0));
        guard.executeProtection(mp, ALICE);
    }

    function test_RescuesLiquidatablePosition_PartialReserve() public {
        _demoSetup();
        _crash(2500); // -25% => collateral $1,500, LTV 80% > LLTV 77%
        assertFalse(guard.getPositionRisk(mp, ALICE).healthy, "liquidatable");

        // 225 mUSDC would be needed for 65%; the 200 reserve is not enough => honest partial protection.
        Executed memory e = _executeAndDecode(mp, ALICE);
        assertEq(e.assetsRepaid, RESERVE);
        assertFalse(e.targetReached, "not reported as fully protected");
        assertApproxEqAbs(e.ltvAfter, 0.666666666666666667e18, 1e12); // 1000 / 1500
        assertTrue(guard.getPositionRisk(mp, ALICE).healthy, "no longer liquidatable");
    }

    function test_RescuesLiquidatablePosition_ToTarget() public {
        _demoSetup();
        _deposit(ALICE, mp, 100e6); // reserve 300
        _crash(2500);
        assertFalse(guard.getPositionRisk(mp, ALICE).healthy, "liquidatable");

        Executed memory e = _executeAndDecode(mp, ALICE);
        assertApproxEqAbs(e.assetsRepaid, 225e6, 10);
        assertTrue(e.targetReached);
        assertLe(e.ltvAfter, TARGET);
        assertTrue(guard.getPositionRisk(mp, ALICE).healthy, "healthy again");
    }

    function test_MaxRepayPerExecutionCap() public {
        _openPosition(ALICE, mp, COLLATERAL, BORROW);
        _deposit(ALICE, mp, RESERVE);
        _setPolicy(ALICE, mp, 50e6, 0); // cap 50 per execution
        _crash(2000);

        Executed memory e = _executeAndDecode(mp, ALICE);
        assertEq(e.assetsRepaid, 50e6, "capped");
        assertFalse(e.targetReached);
        assertEq(e.reserveAfter, RESERVE - 50e6);

        // 1150 / 1600 = 71.9% still >= 70%: a second capped execution is allowed (no cooldown).
        e = _executeAndDecode(mp, ALICE);
        assertEq(e.assetsRepaid, 50e6);
        assertEq(guard.reserveOf(ALICE, id), RESERVE - 100e6);
    }

    function test_FullRepaymentWhenCollateralCollapses() public {
        SettableOracle o = new SettableOracle();
        o.setPrice(5e26); // $500
        MarketParams memory params = _marketWithOracle(address(o));
        _openPosition(ALICE, params, COLLATERAL, BORROW);
        _deposit(ALICE, params, 2000e6);
        _setPolicy(ALICE, params, 2000e6, 0);
        skip(1 days); // accrue some interest so the debt is not a round number
        o.setPrice(1); // collateral value rounds to 0 => the whole debt must be repaid

        Executed memory e = _executeAndDecode(params, ALICE);
        assertGt(e.debtBefore, BORROW);
        assertEq(e.debtAfter, 0, "debt fully cleared");
        assertEq(_borrowShares(params.id(), ALICE), 0, "no dust shares (repaid by shares)");
        assertEq(e.assetsRepaid, e.debtBefore);
        assertTrue(e.targetReached);
        assertEq(guard.reserveOf(ALICE, params.id()), 2000e6 - e.assetsRepaid);
        assertEq(usdc.allowance(address(guard), address(morpho)), 0);
    }

    function test_RepeatedKeeperCalls_AreIdempotent() public {
        _demoSetup();
        _crash(2000);
        Executed memory e = _executeAndDecode(mp, ALICE);

        // Same block, second keeper: position is back at target, so it reverts and moves no funds.
        uint256 reserveBefore = guard.reserveOf(ALICE, id);
        vm.prank(makeAddr("keeper2"));
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.PositionHealthy.selector, e.ltvAfter, TRIGGER));
        guard.executeProtection(mp, ALICE);
        assertEq(guard.reserveOf(ALICE, id), reserveBefore);
    }

    function test_Cooldown() public {
        _openPosition(ALICE, mp, COLLATERAL, BORROW);
        _deposit(ALICE, mp, 1000e6);
        _setPolicy(ALICE, mp, MAX_REPAY, 1 hours);
        _crash(2000);
        _executeAndDecode(mp, ALICE);

        _crash(1500); // another -15%: LTV back above trigger
        ProtectionPreview memory pre = guard.previewProtection(mp, ALICE);
        assertEq(uint8(pre.status), uint8(PreviewStatus.CooldownActive));
        assertEq(pre.nextExecutionTime, block.timestamp + 1 hours);

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IRWASafetyGuard.CooldownActive.selector, block.timestamp + 1 hours));
        guard.executeProtection(mp, ALICE);

        skip(1 hours);
        Executed memory e = _executeAndDecode(mp, ALICE);
        assertLe(e.ltvAfter, TARGET);
    }

    /* ═════════════════════ oracle validation ═════════════════════ */

    function _marketWithOracle(address oracle_) internal returns (MarketParams memory params) {
        params = MarketParams({
            loanToken: address(usdc), collateralToken: address(spy), oracle: oracle_, irm: adaptiveIrm, lltv: LLTV
        });
        morpho.createMarket(params);
        _supplyLiquidity(params, LIQUIDITY);
    }

    function test_RevertWhen_OraclePriceZero() public {
        SettableOracle o = new SettableOracle();
        o.setPrice(5e26); // $500
        MarketParams memory params = _marketWithOracle(address(o));
        _openPosition(ALICE, params, COLLATERAL, BORROW);
        _deposit(ALICE, params, RESERVE);
        _setPolicy(ALICE, params, MAX_REPAY, 0);

        o.setPrice(0);
        assertEq(uint8(guard.previewProtection(params, ALICE).status), uint8(PreviewStatus.InvalidPrice));
        PositionRisk memory risk = guard.getPositionRisk(params, ALICE);
        assertEq(risk.oraclePrice, 0);
        assertEq(risk.ltv, type(uint256).max);
        assertFalse(risk.healthy);

        vm.prank(KEEPER);
        vm.expectRevert(IRWASafetyGuard.InvalidOraclePrice.selector);
        guard.executeProtection(params, ALICE);
        assertEq(guard.reserveOf(ALICE, params.id()), RESERVE, "no funds moved on bad data");
    }

    function test_RevertWhen_OracleReverts() public {
        ToggleRevertOracle o = new ToggleRevertOracle(5e26);
        MarketParams memory params = _marketWithOracle(address(o));
        _openPosition(ALICE, params, COLLATERAL, BORROW);
        _deposit(ALICE, params, RESERVE);
        _setPolicy(ALICE, params, MAX_REPAY, 0);

        o.setBroken(true);
        // Views degrade gracefully; execution refuses to act.
        assertEq(uint8(guard.previewProtection(params, ALICE).status), uint8(PreviewStatus.InvalidPrice));
        assertEq(guard.getPositionRisk(params, ALICE).oraclePrice, 0);
        vm.prank(KEEPER);
        vm.expectRevert("oracle down");
        guard.executeProtection(params, ALICE);
    }

    function test_MockOracleRejectsInvalidValues() public {
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(MockRWAOracle.InvalidTestPrice.selector, 0));
        oracle.setTestPrice(0);
        uint256 tooHigh = oracle.MAX_PRICE_E8() + 1;
        vm.expectRevert(abi.encodeWithSelector(MockRWAOracle.InvalidTestPrice.selector, tooHigh));
        oracle.setTestPrice(tooHigh);
        vm.expectRevert(abi.encodeWithSelector(MockRWAOracle.InvalidShock.selector, 0));
        oracle.applyTestPriceShock(0);
        vm.expectRevert(abi.encodeWithSelector(MockRWAOracle.InvalidShock.selector, 10_000));
        oracle.applyTestPriceShock(10_000);
        vm.stopPrank();
        assertEq(oracle.priceE8(), PRICE_E8, "unchanged");
    }

    /* ═════════════════════ views ═════════════════════ */

    function test_PositionRiskMetrics() public {
        _demoSetup();
        PositionRisk memory r = guard.getPositionRisk(mp, ALICE);
        uint256 scale = oracle.SCALE();
        // Liquidation price = 1200 / (4 * 0.77) = $389.61...; trigger price = 1200 / (4 * 0.70) = $428.57...
        assertApproxEqRel(r.liquidationPrice / scale, 389.61038961e8, 1e12);
        assertApproxEqRel(r.triggerPrice / scale, 428.57142857e8, 1e12);
        // Price can fall 1 - 0.60/0.77 = 22.08% before liquidation.
        assertApproxEqRel(r.priceDropToLiquidation, 0.220779220779e18, 1e10);
        assertEq(r.maxBorrow, 1540e6);
        assertEq(r.oraclePrice, PRICE_E8 * scale);
        assertEq(r.collateral, COLLATERAL);

        // Morpho agrees on the liquidation threshold: at the liquidation price the position flips to unhealthy.
        vm.prank(ALICE);
        oracle.setTestPrice(r.liquidationPrice / scale + 1);
        assertTrue(guard.getPositionRisk(mp, ALICE).healthy);
        vm.prank(ALICE);
        oracle.setTestPrice(r.liquidationPrice / scale - 1);
        assertFalse(guard.getPositionRisk(mp, ALICE).healthy);
    }

    function test_PreviewAtHypotheticalPrice() public {
        _demoSetup();
        ProtectionPreview memory p = guard.previewProtectionAtPrice(mp, ALICE, oracle.toMorphoPrice(400e8));
        assertTrue(p.executable);
        assertEq(p.currentLtv, 0.75e18);
        assertApproxEqAbs(p.repayAmount, 160e6, 10);
        assertApproxEqAbs(p.expectedDebtAfter, 1040e6, 10);
        assertLe(p.expectedLtvAfter, TARGET);
        assertApproxEqAbs(p.reserveAfter, 40e6, 10);
        // Hypothetical only: on-chain state unchanged.
        assertEq(guard.getPositionRisk(mp, ALICE).ltv, 0.6e18);
    }

    function test_GetDashboard() public {
        _demoSetup();
        (PositionRisk memory r, ProtectionPolicy memory p, ProtectionPreview memory pv) = guard.getDashboard(mp, ALICE);
        assertEq(r.ltv, 0.6e18);
        assertTrue(p.enabled);
        assertEq(uint8(pv.status), uint8(PreviewStatus.BelowTrigger));
    }

    function test_Registry_Pagination() public {
        _setPolicy(ALICE, mp, MAX_REPAY, 0);
        _setPolicy(BOB, mp, MAX_REPAY, 0);
        _setPolicy(KEEPER, mp, MAX_REPAY, 0);
        assertEq(guard.protectedPositionsCount(), 3);
        ProtectedPosition[] memory page = guard.getProtectedPositions(1, 10);
        assertEq(page.length, 2);
        assertEq(page[0].user, BOB);
        assertEq(page[1].user, KEEPER);
        assertEq(Id.unwrap(page[0].id), Id.unwrap(id));
        assertEq(guard.getProtectedPositions(3, 10).length, 0);
        assertEq(guard.getProtectedPositions(0, 1).length, 1);
    }

    /* ═════════════════════ authorization & reentrancy ═════════════════════ */

    function test_UsersCannotTouchOthersPolicies() public {
        _setPolicy(ALICE, mp, MAX_REPAY, 0);
        vm.prank(BOB);
        guard.setProtectionPolicy(mp, 0.5e18, 0.4e18, 1e6, 0, false);
        vm.prank(BOB);
        guard.disableProtection(mp);

        ProtectionPolicy memory a = guard.getProtectionPolicy(ALICE, id);
        assertTrue(a.enabled, "ALICE still enabled");
        assertEq(a.triggerLtv, TRIGGER, "ALICE unchanged");
    }

    function test_OnlyOracleOwnerCanMovePrice() public {
        bytes32 role = oracle.PRICE_UPDATER_ROLE();
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, BOB, role));
        oracle.setTestPrice(1e8);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, BOB, role));
        oracle.applyTestPriceShock(2000);
        // The factory itself holds no privileges over the oracle.
        assertFalse(oracle.hasRole(role, address(factory)));
        assertFalse(oracle.hasRole(oracle.DEFAULT_ADMIN_ROLE(), address(factory)));
    }

    function _reentrantMarket(ReentrantToken t) internal returns (MarketParams memory params) {
        MockRWAOracle o = new MockRWAOracle(address(this), 18, 6, PRICE_E8);
        params = MarketParams({
            loanToken: address(t), collateralToken: address(spy), oracle: address(o), irm: adaptiveIrm, lltv: LLTV
        });
        morpho.createMarket(params);
        t.mint(LENDER, LIQUIDITY);
        vm.startPrank(LENDER);
        t.approve(address(morpho), LIQUIDITY);
        morpho.supply(params, LIQUIDITY, 0, LENDER, "");
        vm.stopPrank();

        _openPosition(ALICE, params, COLLATERAL, BORROW);
        t.mint(ALICE, RESERVE);
        vm.startPrank(ALICE);
        t.approve(address(guard), RESERVE);
        guard.depositReserve(params, RESERVE);
        vm.stopPrank();
        _setPolicy(ALICE, params, MAX_REPAY, 0);
        o.applyTestPriceShock(2000);
    }

    function test_Reentrancy_ExecuteDuringRepayIsBlocked() public {
        ReentrantToken t = new ReentrantToken();
        MarketParams memory params = _reentrantMarket(t);
        t.arm(guard, params, ALICE, ReentrantToken.Attack.ExecuteAgain);

        vm.prank(KEEPER);
        (uint256 repaid,) = guard.executeProtection(params, ALICE);

        assertTrue(t.attempted(), "attack attempted");
        assertEq(bytes4(t.lastRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "blocked");
        assertEq(guard.reserveOf(ALICE, params.id()), RESERVE - repaid, "only one repayment");
        assertEq(t.balanceOf(address(guard)), guard.totalReserves(address(t)));
    }

    function test_Reentrancy_WithdrawDuringRepayIsBlocked() public {
        ReentrantToken t = new ReentrantToken();
        MarketParams memory params = _reentrantMarket(t);
        t.arm(guard, params, ALICE, ReentrantToken.Attack.WithdrawReserve);

        vm.prank(KEEPER);
        guard.executeProtection(params, ALICE);
        assertEq(bytes4(t.lastRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(t.balanceOf(address(guard)), guard.totalReserves(address(t)));
    }

    function test_Reentrancy_DepositDuringDepositIsBlocked() public {
        ReentrantToken t = new ReentrantToken();
        MarketParams memory params = _reentrantMarket(t);
        t.arm(guard, params, ALICE, ReentrantToken.Attack.DepositAgain);

        t.mint(BOB, 10e6);
        vm.startPrank(BOB);
        t.approve(address(guard), 10e6);
        guard.depositReserve(params, 10e6);
        vm.stopPrank();
        assertEq(bytes4(t.lastRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(guard.reserveOf(BOB, params.id()), 10e6);
        assertEq(t.balanceOf(address(guard)), guard.totalReserves(address(t)));
    }

    /* ═════════════════════ fuzz: rounding & decimals ═════════════════════ */

    /// @dev For arbitrary positions, crashes and elapsed time: the preview equals the execution, reserves are
    /// conserved, and whenever the target is reported reachable the post-LTV is <= target.
    function testFuzz_ExecutionInvariants(
        uint256 collateral,
        uint256 initialLtvBps,
        uint256 dropBps,
        uint256 reserve,
        uint256 elapsed
    ) public {
        collateral = bound(collateral, 1e12, 50e18); // 0.000001 - 50 mSPY (fits the 20k mUSDC of liquidity)
        initialLtvBps = bound(initialLtvBps, 1000, 6900); // 10% - 69%
        dropBps = bound(dropBps, 0, 9000);
        reserve = bound(reserve, 1, 1_000_000e6);
        elapsed = bound(elapsed, 0, 365 days);

        uint256 value = collateral * PRICE_E8 / 1e20; // in mUSDC units (18 dec, $ e8 -> 6 dec)
        uint256 borrow = value * initialLtvBps / 10_000;
        vm.assume(borrow > 0 && borrow < LIQUIDITY);

        _openPosition(ALICE, mp, collateral, borrow);
        _deposit(ALICE, mp, reserve);
        _setPolicy(ALICE, mp, type(uint128).max, 0);
        skip(elapsed);
        if (dropBps > 0) _crash(dropBps);

        ProtectionPreview memory pre = guard.previewProtection(mp, ALICE);
        if (!pre.executable) {
            vm.prank(KEEPER);
            vm.expectRevert();
            guard.executeProtection(mp, ALICE);
            return;
        }

        uint256 debtBefore = _debtOf(mp, ALICE);
        Executed memory e = _executeAndDecode(mp, ALICE);

        assertEq(e.debtBefore, debtBefore, "debt incl. interest");
        assertEq(e.assetsRepaid, pre.repayAmount, "preview == execution");
        assertEq(e.debtAfter, pre.expectedDebtAfter, "share math replicated exactly");
        assertEq(e.debtAfter, _debtOf(mp, ALICE));
        assertLt(e.debtAfter, e.debtBefore, "debt reduced");
        assertEq(e.reserveAfter, reserve - e.assetsRepaid, "reserve conserved");
        assertLe(e.assetsRepaid, reserve);
        assertEq(usdc.balanceOf(address(guard)), guard.totalReserves(address(usdc)));
        assertEq(usdc.allowance(address(guard), address(morpho)), 0);
        if (pre.targetReachable) {
            assertTrue(e.targetReached, "reachable => reached");
            assertLe(e.ltvAfter, TARGET, "post LTV <= target");
        } else {
            assertEq(e.reserveAfter, 0, "unreachable only when the reserve is exhausted");
        }
    }
}
