// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";
import {MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";

import {RWASafetyGuard} from "../../src/RWASafetyGuard.sol";

/// @dev Oracle whose price can be set to anything, including invalid values (0).
contract SettableOracle is IOracle {
    uint256 public price;

    function setPrice(uint256 p) external {
        price = p;
    }
}

/// @dev Oracle that can be switched to revert.
contract ToggleRevertOracle is IOracle {
    uint256 internal _price;
    bool public broken;

    constructor(uint256 p) {
        _price = p;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function price() external view returns (uint256) {
        require(!broken, "oracle down");
        return _price;
    }
}

/// @dev Malicious 6-decimal loan token that re-enters the guard while tokens are being pulled from it.
contract ReentrantToken is ERC20 {
    enum Attack {
        None,
        ExecuteAgain,
        WithdrawReserve,
        DepositAgain
    }

    RWASafetyGuard public guard;
    MarketParams internal _mp;
    address public victim;
    Attack public attack;
    bool public attempted;
    bytes public lastRevertData;

    constructor() ERC20("Reentrant", "REENT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(RWASafetyGuard guard_, MarketParams memory mp_, address victim_, Attack attack_) external {
        guard = guard_;
        _mp = mp_;
        victim = victim_;
        attack = attack_;
        attempted = false;
        delete lastRevertData;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (attack != Attack.None && !attempted) {
            attempted = true;
            if (attack == Attack.ExecuteAgain && from == address(guard)) {
                try guard.executeProtection(_mp, victim) {}
                catch (bytes memory reason) {
                    lastRevertData = reason;
                }
            } else if (attack == Attack.WithdrawReserve && from == address(guard)) {
                try guard.withdrawReserve(_mp, 1) {}
                catch (bytes memory reason) {
                    lastRevertData = reason;
                }
            } else if (attack == Attack.DepositAgain && to == address(guard)) {
                try guard.depositReserve(_mp, 1) {}
                catch (bytes memory reason) {
                    lastRevertData = reason;
                }
            }
        }
        return super.transferFrom(from, to, value);
    }
}
