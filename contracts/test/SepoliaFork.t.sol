// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

import {RWASafetyGuard} from "../src/RWASafetyGuard.sol";
import {PositionRisk, ProtectionPreview} from "../src/interfaces/IRWASafetyGuard.sol";
import {MockRWAToken} from "../src/mocks/MockRWAToken.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockRWAOracle} from "../src/mocks/MockRWAOracle.sol";
import {DemoMarketFactory} from "../src/demo/DemoMarketFactory.sol";

/// @notice Runs the hackathon scenario against the REAL Morpho Blue deployment on a Sepolia fork.
/// Skipped unless SEPOLIA_RPC_URL is set:  SEPOLIA_RPC_URL=https://... forge test --match-contract SepoliaFork
contract SepoliaForkTest is Test {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    address internal constant MORPHO = 0xd011EE229E7459ba1ddd22631eF7bF528d424A14;
    address internal constant ADAPTIVE_CURVE_IRM = 0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c;
    uint256 internal constant LLTV = 0.77e18;

    bool internal forked;
    IMorpho internal morpho = IMorpho(MORPHO);

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function test_Fork_SepoliaMorphoSupportsDemoParams() public onlyFork {
        assertEq(block.chainid, 11_155_111);
        assertGt(MORPHO.code.length, 0, "Morpho deployed");
        assertTrue(morpho.isIrmEnabled(ADAPTIVE_CURVE_IRM), "AdaptiveCurveIrm enabled");
        assertTrue(morpho.isLltvEnabled(LLTV), "LLTV 77% enabled");
    }

    function test_Fork_FullScenarioOnRealMorpho() public onlyFork {
        address deployer = makeAddr("deployer");
        address borrower = makeAddr("borrower");
        address lender = makeAddr("lender");
        address keeper = makeAddr("keeper");

        vm.startPrank(deployer);
        MockUSDC usdc = new MockUSDC(deployer);
        MockRWAToken spy = new MockRWAToken(deployer);
        RWASafetyGuard guard = new RWASafetyGuard(MORPHO);
        DemoMarketFactory factory =
            new DemoMarketFactory(MORPHO, address(usdc), address(spy), ADAPTIVE_CURVE_IRM, LLTV, 500e8);
        usdc.mint(lender, 10_000e6);
        usdc.mint(borrower, 200e6);
        spy.mint(borrower, 4e18);
        vm.stopPrank();

        vm.prank(borrower);
        (MarketParams memory mp, Id id) = factory.createDemoMarket(0);

        vm.startPrank(lender);
        usdc.approve(MORPHO, type(uint256).max);
        morpho.supply(mp, 10_000e6, 0, lender, "");
        vm.stopPrank();

        vm.startPrank(borrower);
        spy.approve(MORPHO, type(uint256).max);
        morpho.supplyCollateral(mp, 4e18, borrower, "");
        morpho.borrow(mp, 1200e6, 0, borrower, borrower);
        usdc.approve(address(guard), 200e6);
        guard.depositReserve(mp, 200e6);
        guard.setProtectionPolicy(mp, 0.7e18, 0.65e18, 500e6, 0, true);
        vm.stopPrank();

        assertEq(guard.getPositionRisk(mp, borrower).ltv, 0.6e18);

        vm.prank(borrower);
        MockRWAOracle(mp.oracle).applyTestPriceShock(2000);
        assertEq(guard.getPositionRisk(mp, borrower).ltv, 0.75e18);

        ProtectionPreview memory pre = guard.previewProtection(mp, borrower);
        assertTrue(pre.executable);

        vm.prank(keeper);
        (uint256 repaid,) = guard.executeProtection(mp, borrower);
        assertApproxEqAbs(repaid, 160e6, 10);

        PositionRisk memory risk = guard.getPositionRisk(mp, borrower);
        assertApproxEqAbs(risk.debt, 1040e6, 10);
        assertLe(risk.ltv, 0.65e18);
        assertApproxEqAbs(guard.reserveOf(borrower, id), 40e6, 10);
    }
}
