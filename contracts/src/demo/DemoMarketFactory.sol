// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";

import {MockRWAOracle} from "../mocks/MockRWAOracle.sol";

/// @title DemoMarketFactory
/// @notice TESTNET DEMO HELPER. Creates an isolated mSPY/mUSDC market on the *real* Morpho Blue contract, with a
/// fresh MockRWAOracle whose price-updater role belongs to the caller. Each demo user therefore gets their own market:
/// simulating a crash on it cannot affect anyone else's position.
/// @dev The factory holds no funds and no privileges: it only deploys an oracle and calls `Morpho.createMarket`, which
/// is permissionless for enabled IRMs / LLTVs.
contract DemoMarketFactory {
    using MarketParamsLib for MarketParams;

    IMorpho public immutable MORPHO;
    address public immutable LOAN_TOKEN;
    address public immutable COLLATERAL_TOKEN;
    address public immutable IRM;
    uint256 public immutable LLTV;
    uint256 public immutable DEFAULT_PRICE_E8;
    uint8 public immutable LOAN_DECIMALS;
    uint8 public immutable COLLATERAL_DECIMALS;

    mapping(address creator => MarketParams[]) internal _marketsOf;

    event DemoMarketCreated(address indexed creator, Id indexed id, address indexed oracle, uint256 initialPriceE8);

    error ZeroAddress();
    error IrmNotEnabled(address irm);
    error LltvNotEnabled(uint256 lltv);

    constructor(
        address morpho,
        address loanToken,
        address collateralToken,
        address irm,
        uint256 lltv,
        uint256 defaultPriceE8
    ) {
        if (morpho == address(0) || loanToken == address(0) || collateralToken == address(0)) {
            revert ZeroAddress();
        }
        // Verify the parameters are supported by this Morpho deployment before anyone tries to create a market.
        if (!IMorpho(morpho).isIrmEnabled(irm)) revert IrmNotEnabled(irm);
        if (!IMorpho(morpho).isLltvEnabled(lltv)) revert LltvNotEnabled(lltv);

        MORPHO = IMorpho(morpho);
        LOAN_TOKEN = loanToken;
        COLLATERAL_TOKEN = collateralToken;
        IRM = irm;
        LLTV = lltv;
        DEFAULT_PRICE_E8 = defaultPriceE8;
        LOAN_DECIMALS = IERC20Metadata(loanToken).decimals();
        COLLATERAL_DECIMALS = IERC20Metadata(collateralToken).decimals();
    }

    /// @notice Deploy a caller-controlled test oracle and create the corresponding Morpho market.
    /// @param initialPriceE8 Initial mSPY price in mUSDC with 8 decimals (0 = default).
    function createDemoMarket(uint256 initialPriceE8) external returns (MarketParams memory marketParams, Id id) {
        uint256 priceE8 = initialPriceE8 == 0 ? DEFAULT_PRICE_E8 : initialPriceE8;
        MockRWAOracle oracle = new MockRWAOracle(msg.sender, COLLATERAL_DECIMALS, LOAN_DECIMALS, priceE8);

        marketParams = MarketParams({
            loanToken: LOAN_TOKEN, collateralToken: COLLATERAL_TOKEN, oracle: address(oracle), irm: IRM, lltv: LLTV
        });
        MORPHO.createMarket(marketParams);
        id = marketParams.id();

        _marketsOf[msg.sender].push(marketParams);
        emit DemoMarketCreated(msg.sender, id, address(oracle), priceE8);
    }

    function marketsCount(address creator) external view returns (uint256) {
        return _marketsOf[creator].length;
    }

    function getMarkets(address creator) external view returns (MarketParams[] memory) {
        return _marketsOf[creator];
    }

    /// @notice The most recent market created by `creator`.
    function latestMarket(address creator)
        external
        view
        returns (bool exists, MarketParams memory marketParams, Id id)
    {
        uint256 n = _marketsOf[creator].length;
        if (n == 0) return (false, marketParams, id);
        marketParams = _marketsOf[creator][n - 1];
        return (true, marketParams, marketParams.id());
    }
}
