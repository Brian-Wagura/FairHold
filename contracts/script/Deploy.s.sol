// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MediatedEscrow} from "../src/MediatedEscrow.sol";

/// @notice Deploys MediatedEscrow bound to tUSD8.
/// forge script script/Deploy.s.sol --rpc-url aevum --account <keystore> --broadcast --legacy
contract Deploy is Script {
    address internal constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external returns (MediatedEscrow escrow) {
        address token = vm.envOr("TUSD8_ADDRESS", AEVUM_TUSD8);
        require(token.code.length > 0, "token has no code on this chain");
        vm.startBroadcast();
        escrow = new MediatedEscrow(IERC20(token));
        vm.stopBroadcast();
        console2.log("MediatedEscrow:", address(escrow));
        console2.log("token:", token);
        console2.log("chainId:", block.chainid);
    }
}
