// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";

import {RWASafetyGuard} from "../src/RWASafetyGuard.sol";
import {PositionRisk, ProtectionPreview} from "../src/interfaces/IRWASafetyGuard.sol";
import {MockRWAToken} from "../src/mocks/MockRWAToken.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockRWAOracle} from "../src/mocks/MockRWAOracle.sol";
import {DemoMarketFactory} from "../src/demo/DemoMarketFactory.sol";

/// @notice Reproducible end-to-end hackathon scenario, broadcast as real transactions from one wallet:
/// faucet -> fresh Morpho market -> liquidity -> $2,000 collateral -> $1,200 borrow -> 200 mUSDC reserve ->
/// 70%/65% policy -> -20% price -> executeProtection. Tx hashes land in broadcast/DemoScenario.s.sol/<chainId>/.
///
///   forge script script/DemoScenario.s.sol --rpc-url <rpc> --broadcast (--unlocked --sender <addr> | --account <ks>)
contract DemoScenario is Script {
    function run() external {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IMorpho morpho = IMorpho(vm.parseJsonAddress(json, ".morpho"));
        MockUSDC usdc = MockUSDC(vm.parseJsonAddress(json, ".mockUSDC"));
        MockRWAToken spy = MockRWAToken(vm.parseJsonAddress(json, ".mockRWAToken"));
        RWASafetyGuard guard = RWASafetyGuard(vm.parseJsonAddress(json, ".rwaSafetyGuard"));
        DemoMarketFactory factory = DemoMarketFactory(vm.parseJsonAddress(json, ".demoMarketFactory"));

        vm.startBroadcast();
        (, address user,) = vm.readCallers();

        // Step 2: test assets from the rate-limited faucets.
        spy.faucet(4e18);
        usdc.faucet(5200e6);

        // Step 3: a fresh Morpho Blue market (the caller owns its TEST oracle), liquidity, collateral, borrow.
        (MarketParams memory mp, Id id) = factory.createDemoMarket(500e8);
        usdc.approve(address(morpho), 5000e6);
        morpho.supply(mp, 5000e6, 0, user, "");
        spy.approve(address(morpho), 4e18);
        morpho.supplyCollateral(mp, 4e18, user, "");
        morpho.borrow(mp, 1200e6, 0, user, user);

        // Steps 4-5: protection reserve and policy (trigger 70%, target 65%, max 500 mUSDC, no cooldown).
        IERC20(address(usdc)).approve(address(guard), 200e6);
        guard.depositReserve(mp, 200e6);
        guard.setProtectionPolicy(mp, 0.7e18, 0.65e18, 500e6, 0, true);
        _log("Before shock", guard.getPositionRisk(mp, user));

        // Step 6-7: TEST-ONLY oracle shock of -20%.
        MockRWAOracle(mp.oracle).applyTestPriceShock(2000);
        _log("After -20% shock", guard.getPositionRisk(mp, user));
        ProtectionPreview memory pre = guard.previewProtection(mp, user);
        console2.log("Executable:", pre.executable, " expected repay (mUSDC e6):", pre.repayAmount);

        // Step 8: on-chain protection (anyone may call; here the same wallet acts as keeper).
        (uint256 repaid, uint256 shares) = guard.executeProtection(mp, user);
        vm.stopBroadcast();

        // Steps 9-10.
        console2.log("Repaid assets (e6):", repaid, " shares:", shares);
        _log("After protection", guard.getPositionRisk(mp, user));
        console2.log("Market id:");
        console2.logBytes32(Id.unwrap(id));
        console2.log("Oracle:", mp.oracle);
    }

    function _log(string memory label, PositionRisk memory r) internal pure {
        console2.log("--", label);
        console2.log("   collateral value (e6):", r.collateralValue);
        console2.log("   debt (e6):            ", r.debt);
        console2.log("   LTV (bps):            ", r.ltv * 10_000 / 1e18);
        console2.log("   reserve (e6):         ", r.reserve);
        console2.log("   healthy:              ", r.healthy);
    }
}
