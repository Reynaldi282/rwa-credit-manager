// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {ORACLE_PRICE_SCALE} from "morpho-blue/src/libraries/ConstantsLib.sol";

import {BaseTest} from "./BaseTest.sol";
import {MockRWAOracle} from "../src/mocks/MockRWAOracle.sol";
import {TestnetFaucetToken} from "../src/mocks/TestnetFaucetToken.sol";
import {DemoMarketFactory} from "../src/demo/DemoMarketFactory.sol";

contract MockTokensTest is BaseTest {
    function test_TokenMetadata() public view {
        assertEq(usdc.symbol(), "mUSDC");
        assertEq(usdc.decimals(), 6);
        assertEq(spy.symbol(), "mSPY");
        assertEq(spy.decimals(), 18);
        assertTrue(usdc.IS_TESTNET_TOKEN());
        assertTrue(spy.IS_TESTNET_TOKEN());
    }

    function test_FaucetPerCallLimit() public {
        uint256 maxPerCall = usdc.faucetMaxPerCall();
        vm.prank(ALICE);
        usdc.faucet(maxPerCall);
        assertEq(usdc.balanceOf(ALICE), maxPerCall);

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(TestnetFaucetToken.FaucetPerCallLimitExceeded.selector, maxPerCall + 1, maxPerCall)
        );
        usdc.faucet(maxPerCall + 1);

        vm.prank(ALICE);
        vm.expectRevert(TestnetFaucetToken.FaucetZeroAmount.selector);
        usdc.faucet(0);
    }

    function test_FaucetWindowLimitAndReset() public {
        uint256 perCall = spy.faucetMaxPerCall();
        uint256 perWindow = spy.faucetMaxPerWindow();
        uint256 calls = perWindow / perCall;
        vm.startPrank(ALICE);
        for (uint256 i; i < calls; ++i) {
            spy.faucet(perCall);
        }
        assertEq(spy.faucetRemaining(ALICE), 0);
        vm.expectRevert(abi.encodeWithSelector(TestnetFaucetToken.FaucetWindowLimitExceeded.selector, 1, 0));
        spy.faucet(1);

        skip(spy.FAUCET_WINDOW());
        assertEq(spy.faucetRemaining(ALICE), perWindow);
        spy.faucet(perCall);
        vm.stopPrank();
        assertEq(spy.balanceOf(ALICE), perWindow + perCall);
        assertEq(spy.faucetRemaining(BOB), perWindow, "limits are per address");
    }

    function test_OnlyMinterCanMint() public {
        bytes32 role = usdc.MINTER_ROLE();
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ALICE, role));
        usdc.mint(ALICE, 1);

        vm.prank(DEPLOYER);
        usdc.mint(ALICE, 1_000_000e6); // seeding beyond faucet limits
        assertEq(usdc.balanceOf(ALICE), 1_000_000e6);
    }
}

contract MockRWAOracleTest is BaseTest {
    using MarketParamsLib for MarketParams;

    function test_ScalingMatchesHackathonNumbers() public view {
        // mSPY 18 decimals, mUSDC 6 decimals: SCALE = 10^(36 + 6 - 18 - 8) = 1e16.
        assertEq(oracle.SCALE(), 1e16);
        assertEq(oracle.price(), 5e26);
        // 4 mSPY at $500 is worth exactly 2,000 mUSDC in Morpho's formula.
        assertEq(COLLATERAL * oracle.price() / ORACLE_PRICE_SCALE, 2000e6);
        assertTrue(oracle.IS_TEST_ORACLE());
    }

    /// @dev The real Morpho contract enforces maxBorrow = collateral * price / 1e36 * LLTV. With $2,000 of collateral
    /// and LLTV 77%, exactly 1,540 mUSDC can be borrowed and not one unit more.
    function test_MorphoBorrowLimitConfirmsOracleScale() public {
        _mintSpy(BOB, COLLATERAL);
        vm.startPrank(BOB);
        spy.approve(address(morpho), COLLATERAL);
        morpho.supplyCollateral(mp, COLLATERAL, BOB, "");
        vm.expectRevert(bytes("insufficient collateral"));
        morpho.borrow(mp, 1540e6 + 1, 0, BOB, BOB);
        morpho.borrow(mp, 1540e6, 0, BOB, BOB);
        vm.stopPrank();
        assertEq(usdc.balanceOf(BOB), 1540e6);
    }

    function testFuzz_ScalingAcrossDecimals(uint8 collDec, uint8 loanDec, uint256 priceE8) public {
        collDec = uint8(bound(collDec, 0, 24));
        loanDec = uint8(bound(loanDec, 0, 24));
        vm.assume(uint256(36) + loanDec >= uint256(collDec) + 8);
        priceE8 = bound(priceE8, 1e6, 1e14);

        MockRWAOracle o = new MockRWAOracle(address(this), collDec, loanDec, priceE8);
        // 1 whole collateral token must be worth `priceE8 / 1e8` whole loan tokens.
        uint256 value = (10 ** uint256(collDec)) * o.price() / ORACLE_PRICE_SCALE;
        uint256 expected = priceE8 * (10 ** uint256(loanDec)) / 1e8;
        assertEq(value, expected);
    }

    function test_RevertWhen_UnsupportedDecimals() public {
        vm.expectRevert(abi.encodeWithSelector(MockRWAOracle.UnsupportedDecimals.selector, 37, 6));
        new MockRWAOracle(address(this), 37, 6, 500e8);
        vm.expectRevert(abi.encodeWithSelector(MockRWAOracle.UnsupportedDecimals.selector, 36, 0));
        new MockRWAOracle(address(this), 36, 0, 500e8); // 36 + 0 < 36 + 8
    }

    function test_RevertWhen_InvalidInitialPriceOrAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(MockRWAOracle.InvalidTestPrice.selector, 0));
        new MockRWAOracle(address(this), 18, 6, 0);
        vm.expectRevert(MockRWAOracle.ZeroAdmin.selector);
        new MockRWAOracle(address(0), 18, 6, 500e8);
    }

    function test_ShockAndReset() public {
        vm.startPrank(ALICE);
        oracle.applyTestPriceShock(2000);
        assertEq(oracle.priceE8(), 400e8);
        oracle.applyTestPriceShock(5000);
        assertEq(oracle.priceE8(), 200e8);
        oracle.resetTestPrice();
        assertEq(oracle.priceE8(), PRICE_E8);
        vm.stopPrank();
    }

    function test_EmitsTestPriceUpdated() public {
        vm.prank(ALICE);
        vm.expectEmit(address(oracle));
        emit MockRWAOracle.TestPriceUpdated(ALICE, 500e8, 400e8, 400e8 * 1e16);
        oracle.setTestPrice(400e8);
        assertEq(oracle.lastUpdatedAt(), block.timestamp);
    }
}

contract DemoMarketFactoryTest is BaseTest {
    using MarketParamsLib for MarketParams;

    function test_CreatesRealMorphoMarketOwnedByCaller() public {
        vm.prank(BOB);
        (MarketParams memory params,) = factory.createDemoMarket(250e8);

        assertGt(morpho.market(params.id()).lastUpdate, 0, "market exists on Morpho");
        assertEq(params.loanToken, address(usdc));
        assertEq(params.collateralToken, address(spy));
        assertEq(params.irm, adaptiveIrm);
        assertEq(params.lltv, LLTV);

        MockRWAOracle o = MockRWAOracle(params.oracle);
        assertEq(o.priceE8(), 250e8);
        assertTrue(o.hasRole(o.PRICE_UPDATER_ROLE(), BOB));
        assertFalse(o.hasRole(o.PRICE_UPDATER_ROLE(), ALICE));

        (bool exists, MarketParams memory latest,) = factory.latestMarket(BOB);
        assertTrue(exists);
        assertEq(latest.oracle, params.oracle);
        assertEq(factory.marketsCount(BOB), 1);
        assertEq(factory.marketsCount(ALICE), 1); // created in setUp
    }

    function test_EachUserGetsAnIsolatedMarket() public {
        vm.prank(BOB);
        (MarketParams memory bobMarket,) = factory.createDemoMarket(0);
        assertNotEq(bobMarket.oracle, mp.oracle);

        // ALICE crashing her market does not move BOB's price.
        vm.prank(ALICE);
        MockRWAOracle(mp.oracle).applyTestPriceShock(5000);
        assertEq(MockRWAOracle(bobMarket.oracle).priceE8(), PRICE_E8);
    }

    function test_RevertWhen_IrmOrLltvNotEnabled() public {
        vm.expectRevert(abi.encodeWithSelector(DemoMarketFactory.IrmNotEnabled.selector, address(0xbeef)));
        new DemoMarketFactory(address(morpho), address(usdc), address(spy), address(0xbeef), LLTV, PRICE_E8);
        vm.expectRevert(abi.encodeWithSelector(DemoMarketFactory.LltvNotEnabled.selector, 0.5e18));
        new DemoMarketFactory(address(morpho), address(usdc), address(spy), adaptiveIrm, 0.5e18, PRICE_E8);
    }
}
