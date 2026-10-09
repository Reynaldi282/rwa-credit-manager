// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";
import {DeployBase} from "./DeployBase.s.sol";

/// @notice Local Anvil deployment: deploys the OFFICIAL Morpho Blue v1.0.0 and AdaptiveCurveIrm v1.0.0 bytecode
/// (compiled from the pinned upstream sources), then the RWA Credit Manager contracts.
///
///   anvil
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
contract DeployLocal is DeployBase {
    function run() external returns (Deployment memory d) {
        require(block.chainid == 31_337, "DeployLocal: Anvil only");

        vm.startBroadcast();
        address deployer = _broadcaster();

        address morpho = vm.deployCode("Morpho.sol:Morpho", abi.encode(deployer));
        address irm = vm.deployCode("AdaptiveCurveIrm.sol:AdaptiveCurveIrm", abi.encode(morpho));
        // Mirror the Sepolia governance configuration used by the demo.
        IMorpho(morpho).enableIrm(irm);
        IMorpho(morpho).enableIrm(address(0));
        IMorpho(morpho).enableLltv(DEMO_LLTV);
        IMorpho(morpho).enableLltv(0.86e18);

        d = _deployApp(morpho, irm, DEMO_LLTV, deployer);
        vm.stopBroadcast();

        _writeDeployment(d);
    }
}
