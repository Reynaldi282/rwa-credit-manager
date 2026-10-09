// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestnetFaucetToken} from "./TestnetFaucetToken.sol";

/// @title MockUSDC (mUSDC)
/// @notice 6-decimal mock stablecoin used as the Morpho loan token and as the protection reserve. TESTNET ONLY.
contract MockUSDC is TestnetFaucetToken {
    constructor(address admin) TestnetFaucetToken("Mock USD Coin (Test Only)", "mUSDC", 6, 10_000e6, 50_000e6, admin) {}
}
