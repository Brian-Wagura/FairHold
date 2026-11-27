// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MediatedEscrow} from "../src/MediatedEscrow.sol";
import {MockUSD8} from "../test/mocks/MockUSD8.sol";

/// @notice Local anvil bootstrap: mock tUSD8, escrow, mediator with session key, funded demo accounts.
/// Uses anvil's well-known dev accounts 0 (payer), 1 (payee), 2 (mediator owner), 3 (session key).
contract LocalDemo is Script {
    function run() external {
        uint256 payerPk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        uint256 mediatorPk = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
        address payee = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        address sessionKey = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

        vm.startBroadcast(payerPk);
        MockUSD8 usd = new MockUSD8();
        MediatedEscrow escrow = new MediatedEscrow(IERC20(address(usd)));
        usd.mint(vm.addr(payerPk), 10_000e6);
        usd.mint(payee, 1_000e6);
        vm.stopBroadcast();

        vm.startBroadcast(mediatorPk);
        escrow.registerMediator("local://fairhold-mediator");
        escrow.setSessionKey(sessionKey, uint64(block.timestamp + 7 days), 50);
        vm.stopBroadcast();

        console2.log("TUSD8_ADDRESS", address(usd));
        console2.log("ESCROW_ADDRESS", address(escrow));
    }
}
