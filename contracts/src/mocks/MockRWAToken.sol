// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestnetFaucetToken} from "./TestnetFaucetToken.sol";

/// @title MockRWAToken (mSPY)
/// @notice Educational testnet token representing *exposure* to a tokenized S&P 500 ETF, used as Morpho collateral.
/// @dev NOT a security, NOT an ETF share, NOT an Ondo (or any issuer's) token, and has no real-world value or backing.
contract MockRWAToken is TestnetFaucetToken {
    string public constant DISCLAIMER =
        "Educational testnet asset. Not an ETF share, not an Ondo token, no backing, no real-world value.";

    constructor(address admin)
        TestnetFaucetToken("Mock Tokenized S&P 500 ETF (Test Only)", "mSPY", 18, 10e18, 50e18, admin)
    {}
}
