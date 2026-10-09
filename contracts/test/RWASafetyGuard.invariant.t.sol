// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";

import {BaseTest} from "./BaseTest.sol";
import {RWASafetyGuard} from "../src/RWASafetyGuard.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockRWAOracle} from "../src/mocks/MockRWAOracle.sol";

/// @dev Drives random sequences of user / keeper / market actions against the real Morpho deployment.
contract GuardHandler is Test {
    using MarketParamsLib for MarketParams;

    RWASafetyGuard internal guard;
    IMorpho internal morpho;
    MockUSDC internal usdc;
    MockRWAOracle internal oracle;
    MarketParams internal mp;
    address[] public actors;
    address internal minter;

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostRepaid;
    uint256 public executions;

    constructor(
        RWASafetyGuard guard_,
        IMorpho morpho_,
        MockUSDC usdc_,
        MockRWAOracle oracle_,
        MarketParams memory mp_,
        address[] memory actors_,
        address minter_
    ) {
        guard = guard_;
        morpho = morpho_;
        usdc = usdc_;
        oracle = oracle_;
        mp = mp_;
        actors = actors_;
        minter = minter_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        amount = bound(amount, 1, 1000e6);
        vm.prank(minter);
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(guard), amount);
        guard.depositReserve(mp, amount);
        vm.stopPrank();
        ghostDeposited += amount;
    }

    function withdraw(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        uint256 reserve = guard.reserveOf(a, mp.id());
        if (reserve == 0) return;
        amount = bound(amount, 1, reserve);
        vm.prank(a);
        guard.withdrawReserve(mp, amount);
        ghostWithdrawn += amount;
    }

    function setPolicy(uint256 seed, uint256 trigger, uint256 gap, uint256 maxRepay) external {
        address a = _actor(seed);
        trigger = bound(trigger, 0.5e18, 0.76e18);
        gap = bound(gap, 0.01e18, 0.2e18);
        maxRepay = bound(maxRepay, 1, 2000e6);
        vm.prank(a);
        guard.setProtectionPolicy(mp, trigger, trigger - gap, maxRepay, 0, true);
    }

    function crash(uint256 dropBps) external {
        dropBps = bound(dropBps, 100, 3000);
        if (oracle.priceE8() * (10_000 - dropBps) / 10_000 < oracle.MIN_PRICE_E8()) return;
        oracle.applyTestPriceShock(dropBps);
    }

    function recover() external {
        oracle.resetTestPrice();
    }

    function warp(uint256 secs) external {
        skip(bound(secs, 1, 30 days));
    }

    function execute(uint256 seed) external {
        address a = _actor(seed);
        if (!guard.previewProtection(mp, a).executable) return;
        uint256[] memory others = new uint256[](actors.length);
        for (uint256 i; i < actors.length; ++i) {
            others[i] = guard.reserveOf(actors[i], mp.id());
        }
        uint256 debtBefore = morpho.position(mp.id(), a).borrowShares;
        (uint256 repaid, uint256 shares) = guard.executeProtection(mp, a);

        // Ghost checks (asserting inside a handler would be swallowed with fail_on_revert = false).
        for (uint256 i; i < actors.length; ++i) {
            uint256 expected = actors[i] == a ? others[i] - repaid : others[i];
            if (guard.reserveOf(actors[i], mp.id()) != expected) reserveIsolationViolated = true;
        }
        if (morpho.position(mp.id(), a).borrowShares != debtBefore - shares || shares == 0) debtNotReduced = true;
        ghostRepaid += repaid;
        executions++;
    }

    bool public reserveIsolationViolated;
    bool public debtNotReduced;

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }
}

contract RWASafetyGuardInvariantTest is BaseTest {
    using MarketParamsLib for MarketParams;

    GuardHandler internal handler;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        actors.push(ALICE);
        actors.push(BOB);
        actors.push(makeAddr("carol"));
        _supplyLiquidity(mp, 100_000e6);
        for (uint256 i; i < actors.length; ++i) {
            _openPosition(actors[i], mp, COLLATERAL, BORROW);
            _setPolicy(actors[i], mp, MAX_REPAY, 0);
        }
        handler = new GuardHandler(guard, morpho, usdc, oracle, mp, actors, DEPLOYER);
        // ALICE owns the market's test oracle; let the handler simulate price moves.
        bytes32 role = oracle.PRICE_UPDATER_ROLE();
        vm.prank(ALICE);
        oracle.grantRole(role, address(handler));

        targetContract(address(handler));
    }

    function invariant_GuardBalanceEqualsTotalReserves() public view {
        assertEq(usdc.balanceOf(address(guard)), guard.totalReserves(address(usdc)));
    }

    function invariant_SumOfUserReservesEqualsTotal() public view {
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += guard.reserveOf(actors[i], id);
        }
        assertEq(sum, guard.totalReserves(address(usdc)));
    }

    function invariant_ReserveConservation() public view {
        assertEq(
            handler.ghostDeposited() - handler.ghostWithdrawn() - handler.ghostRepaid(),
            guard.totalReserves(address(usdc))
        );
    }

    function invariant_NoStandingAllowanceToMorpho() public view {
        assertEq(usdc.allowance(address(guard), address(morpho)), 0);
    }

    function invariant_ExecutionsOnlyUseOwnReserveAndReduceDebt() public view {
        assertFalse(handler.reserveIsolationViolated(), "another user's reserve changed");
        assertFalse(handler.debtNotReduced(), "execution did not burn borrow shares");
    }
}
