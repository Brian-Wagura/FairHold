// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MediatedEscrow} from "../src/MediatedEscrow.sol";

/// @notice Run with the *mediator owner* key. Registers the mediator identity (if needed) and grants
///         the AI service a scoped session key: propose-only, expiring, with a proposal budget.
/// ESCROW_ADDRESS=0x.. SESSION_KEY=0x.. [SESSION_DAYS=7] [SESSION_BUDGET=25] [MEDIATOR_URI=..] \
///   forge script script/SetupMediator.s.sol --rpc-url aevum --account <owner> --broadcast --legacy
contract SetupMediator is Script {
    function run() external {
        MediatedEscrow escrow = MediatedEscrow(vm.envAddress("ESCROW_ADDRESS"));
        address sessionKey = vm.envAddress("SESSION_KEY");
        uint256 days_ = vm.envOr("SESSION_DAYS", uint256(7));
        uint32 budget = uint32(vm.envOr("SESSION_BUDGET", uint256(25)));
        string memory uri = vm.envOr("MEDIATOR_URI", string("fairhold://mediator/policy-v1"));

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        if (!escrow.getMediator(owner).registered) {
            escrow.registerMediator(uri);
            console2.log("registered mediator", owner);
        }
        escrow.setSessionKey(sessionKey, uint64(block.timestamp + days_ * 1 days), budget);
        vm.stopBroadcast();
        console2.log("session key", sessionKey);
        console2.log("budget", budget);
    }
}
