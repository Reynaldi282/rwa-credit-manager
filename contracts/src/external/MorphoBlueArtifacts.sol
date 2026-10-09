// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.19;

// Compiles the official, unmodified Morpho Blue v1.0.0 and AdaptiveCurveIrm v1.0.0 sources (pinned to solc 0.8.19
// upstream) so that tests and the local Anvil deployment can deploy them with `vm.deployCode`.
// On Sepolia these are NOT redeployed: the official deployment at 0xd011EE229E7459ba1ddd22631eF7bF528d424A14 and
// its enabled AdaptiveCurveIrm at 0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c are used instead.
import {Morpho} from "morpho-blue/src/Morpho.sol";
import {AdaptiveCurveIrm} from "morpho-blue-irm/src/AdaptiveCurveIrm.sol";
import {IrmMock} from "morpho-blue/src/mocks/IrmMock.sol";
