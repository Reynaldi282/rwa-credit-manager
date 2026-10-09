// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";

import {RWASafetyGuard} from "../src/RWASafetyGuard.sol";
import {MockRWAToken} from "../src/mocks/MockRWAToken.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {DemoMarketFactory} from "../src/demo/DemoMarketFactory.sol";

/// @dev Shared deployment logic for local Anvil and Sepolia.
abstract contract DeployBase is Script {
    uint256 internal constant DEMO_LLTV = 0.77e18;
    uint256 internal constant DEFAULT_PRICE_E8 = 500e8; // $500 per mSPY
    uint256 internal constant DEFAULT_MARKET_LIQUIDITY = 100_000e6;

    struct Deployment {
        address morpho;
        address irm;
        uint256 lltv;
        address usdc;
        address spy;
        address guard;
        address factory;
        MarketParams defaultMarket;
        Id defaultMarketId;
        uint256 startBlock;
    }

    function _broadcaster() internal view returns (address sender) {
        (, sender,) = vm.readCallers();
    }

    /// @dev Must be called while broadcasting. The broadcaster becomes the token admin and the default market's
    /// oracle owner.
    function _deployApp(address morpho, address irm, uint256 lltv, address admin)
        internal
        returns (Deployment memory d)
    {
        d.startBlock = block.number;
        d.morpho = morpho;
        d.irm = irm;
        d.lltv = lltv;

        MockUSDC usdc = new MockUSDC(admin);
        MockRWAToken spy = new MockRWAToken(admin);
        RWASafetyGuard guard = new RWASafetyGuard(morpho);
        DemoMarketFactory factory =
            new DemoMarketFactory(morpho, address(usdc), address(spy), irm, lltv, DEFAULT_PRICE_E8);
        d.usdc = address(usdc);
        d.spy = address(spy);
        d.guard = address(guard);
        d.factory = address(factory);

        // A default demo market (oracle owned by the deployer) with seeded lending liquidity.
        (d.defaultMarket, d.defaultMarketId) = factory.createDemoMarket(0);
        usdc.mint(admin, DEFAULT_MARKET_LIQUIDITY);
        usdc.approve(morpho, DEFAULT_MARKET_LIQUIDITY);
        IMorpho(morpho).supply(d.defaultMarket, DEFAULT_MARKET_LIQUIDITY, 0, admin, "");
    }

    function _writeDeployment(Deployment memory d) internal {
        string memory m = "market";
        vm.serializeAddress(m, "loanToken", d.defaultMarket.loanToken);
        vm.serializeAddress(m, "collateralToken", d.defaultMarket.collateralToken);
        vm.serializeAddress(m, "oracle", d.defaultMarket.oracle);
        vm.serializeAddress(m, "irm", d.defaultMarket.irm);
        string memory marketJson = vm.serializeString(m, "lltv", vm.toString(d.defaultMarket.lltv));

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", d.startBlock);
        vm.serializeAddress(k, "morpho", d.morpho);
        vm.serializeAddress(k, "irm", d.irm);
        vm.serializeString(k, "lltv", vm.toString(d.lltv));
        vm.serializeAddress(k, "mockUSDC", d.usdc);
        vm.serializeAddress(k, "mockRWAToken", d.spy);
        vm.serializeAddress(k, "rwaSafetyGuard", d.guard);
        vm.serializeAddress(k, "demoMarketFactory", d.factory);
        vm.serializeBytes32(k, "defaultMarketId", Id.unwrap(d.defaultMarketId));
        string memory json = vm.serializeString(k, "defaultMarket", marketJson);

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        // Only record addresses that were actually broadcast: a dry run must never produce a deployments file.
        bool broadcasting =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (broadcasting) vm.writeJson(json, path);

        console2.log("Morpho Blue        ", d.morpho);
        console2.log("IRM                ", d.irm);
        console2.log("MockUSDC (mUSDC)   ", d.usdc);
        console2.log("MockRWAToken (mSPY)", d.spy);
        console2.log("RWASafetyGuard     ", d.guard);
        console2.log("DemoMarketFactory  ", d.factory);
        console2.log("Default oracle     ", d.defaultMarket.oracle);
        console2.log("Default market id");
        console2.logBytes32(Id.unwrap(d.defaultMarketId));
        if (broadcasting) console2.log("Written to", path);
        else console2.log("DRY RUN - simulated addresses above are NOT deployed; nothing written.");
    }
}
