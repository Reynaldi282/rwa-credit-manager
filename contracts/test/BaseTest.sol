// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IMorpho, Id, MarketParams, Position, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

import {RWASafetyGuard} from "../src/RWASafetyGuard.sol";
import {ProtectionPolicy, PositionRisk, ProtectionPreview} from "../src/interfaces/IRWASafetyGuard.sol";
import {MockRWAToken} from "../src/mocks/MockRWAToken.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockRWAOracle} from "../src/mocks/MockRWAOracle.sol";
import {DemoMarketFactory} from "../src/demo/DemoMarketFactory.sol";

/// @dev Deploys the official Morpho Blue + AdaptiveCurveIrm bytecode (compiled from the pinned upstream sources),
/// the mocks, the guard and the demo factory, and opens the hackathon demo position.
abstract contract BaseTest is Test {
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;
    using MorphoBalancesLib for IMorpho;

    uint256 internal constant LLTV = 0.77e18;
    uint256 internal constant PRICE_E8 = 500e8; // $500 per mSPY
    uint256 internal constant COLLATERAL = 4e18; // 4 mSPY = $2,000
    uint256 internal constant BORROW = 1200e6; // 1,200 mUSDC => 60% LTV
    uint256 internal constant LIQUIDITY = 20_000e6;
    uint256 internal constant TRIGGER = 0.7e18;
    uint256 internal constant TARGET = 0.65e18;
    uint256 internal constant MAX_REPAY = 500e6;
    uint256 internal constant RESERVE = 200e6;

    address internal MORPHO_OWNER = makeAddr("morphoOwner");
    address internal DEPLOYER = makeAddr("deployer");
    address internal LENDER = makeAddr("lender");
    address internal ALICE = makeAddr("alice");
    address internal BOB = makeAddr("bob");
    address internal KEEPER = makeAddr("keeper");

    IMorpho internal morpho;
    address internal adaptiveIrm;
    address internal mockIrm;
    MockUSDC internal usdc;
    MockRWAToken internal spy;
    RWASafetyGuard internal guard;
    DemoMarketFactory internal factory;

    MarketParams internal mp; // ALICE's demo market (ALICE controls its test oracle)
    Id internal id;
    MockRWAOracle internal oracle;

    function setUp() public virtual {
        vm.warp(1_760_000_000);

        morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(MORPHO_OWNER)));
        adaptiveIrm = deployCode("AdaptiveCurveIrm.sol:AdaptiveCurveIrm", abi.encode(address(morpho)));
        mockIrm = deployCode("IrmMock.sol:IrmMock");

        vm.startPrank(MORPHO_OWNER);
        morpho.enableIrm(adaptiveIrm);
        morpho.enableIrm(mockIrm);
        morpho.enableLltv(LLTV);
        vm.stopPrank();

        vm.startPrank(DEPLOYER);
        usdc = new MockUSDC(DEPLOYER);
        spy = new MockRWAToken(DEPLOYER);
        guard = new RWASafetyGuard(address(morpho));
        factory = new DemoMarketFactory(address(morpho), address(usdc), address(spy), adaptiveIrm, LLTV, PRICE_E8);
        vm.stopPrank();

        vm.prank(ALICE);
        (mp, id) = factory.createDemoMarket(0);
        oracle = MockRWAOracle(mp.oracle);

        _supplyLiquidity(mp, LIQUIDITY);

        vm.label(address(morpho), "Morpho");
        vm.label(address(guard), "RWASafetyGuard");
        vm.label(address(usdc), "mUSDC");
        vm.label(address(spy), "mSPY");
    }

    /* ───────────── helpers ───────────── */

    function _mintUsdc(address to, uint256 amount) internal {
        vm.prank(DEPLOYER);
        usdc.mint(to, amount);
    }

    function _mintSpy(address to, uint256 amount) internal {
        vm.prank(DEPLOYER);
        spy.mint(to, amount);
    }

    function _supplyLiquidity(MarketParams memory params, uint256 amount) internal {
        _mintUsdc(LENDER, amount);
        vm.startPrank(LENDER);
        usdc.approve(address(morpho), amount);
        morpho.supply(params, amount, 0, LENDER, "");
        vm.stopPrank();
    }

    function _openPosition(address user, MarketParams memory params, uint256 collateral, uint256 borrow) internal {
        _mintSpy(user, collateral);
        vm.startPrank(user);
        spy.approve(address(morpho), collateral);
        morpho.supplyCollateral(params, collateral, user, "");
        morpho.borrow(params, borrow, 0, user, user);
        vm.stopPrank();
    }

    function _deposit(address user, MarketParams memory params, uint256 amount) internal {
        _mintUsdc(user, amount);
        vm.startPrank(user);
        usdc.approve(address(guard), amount);
        guard.depositReserve(params, amount);
        vm.stopPrank();
    }

    function _setPolicy(address user, MarketParams memory params, uint256 maxRepay, uint256 cooldown) internal {
        vm.prank(user);
        guard.setProtectionPolicy(params, TRIGGER, TARGET, maxRepay, cooldown, true);
    }

    /// @dev The full hackathon setup: $2,000 collateral, $1,200 debt, 200 mUSDC reserve, 70% / 65% policy.
    function _demoSetup() internal {
        _openPosition(ALICE, mp, COLLATERAL, BORROW);
        _deposit(ALICE, mp, RESERVE);
        _setPolicy(ALICE, mp, MAX_REPAY, 0);
    }

    function _crash(uint256 dropBps) internal {
        vm.prank(ALICE);
        oracle.applyTestPriceShock(dropBps);
    }

    function _debtOf(MarketParams memory params, address user) internal view returns (uint256) {
        return morpho.expectedBorrowAssets(params, user);
    }

    function _borrowShares(Id marketId, address user) internal view returns (uint256) {
        return morpho.position(marketId, user).borrowShares;
    }
}
