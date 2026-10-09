// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";
import {DeployBase} from "./DeployBase.s.sol";

/// @notice Sepolia deployment. Uses the EXISTING official Morpho Blue deployment and its enabled AdaptiveCurveIrm;
/// deploys only the RWA Credit Manager contracts and test assets.
///
///   forge script script/DeploySepolia.s.sol --rpc-url sepolia --broadcast --account <keystore> --verify
contract DeploySepolia is DeployBase {
    address internal constant MORPHO = 0xd011EE229E7459ba1ddd22631eF7bF528d424A14;
    address internal constant ADAPTIVE_CURVE_IRM = 0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c;

    function run() external returns (Deployment memory d) {
        require(block.chainid == 11_155_111, "DeploySepolia: Sepolia only (never mainnet)");
        require(MORPHO.code.length > 0, "Morpho not deployed");
        // Verify governance-enabled parameters before attempting market creation.
        require(IMorpho(MORPHO).isIrmEnabled(ADAPTIVE_CURVE_IRM), "IRM not enabled on Morpho");
        require(IMorpho(MORPHO).isLltvEnabled(DEMO_LLTV), "LLTV not enabled on Morpho");

        vm.startBroadcast();
        d = _deployApp(MORPHO, ADAPTIVE_CURVE_IRM, DEMO_LLTV, _broadcaster());
        vm.stopBroadcast();

        _writeDeployment(d);
    }
}
