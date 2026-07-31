// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {FootMon} from "../FootMon.sol";

/**
 * @title VerifyFootMon
 * @notice Read-only health check against the deployed contract. Broadcasts
 *         nothing; reverts if the live wiring does not match local env.
 *
 * Usage:
 *   forge script contract/script/VerifyFootMon.s.sol:VerifyFootMon \
 *     --rpc-url $MONAD_RPC_URL
 *
 * Required env: CONTRACT_ADDRESS, RESOLVER_ADDRESS, OWNER_ADDRESS
 */
contract VerifyFootMon is Script {
    function run() external view {
        FootMon footmon  = FootMon(payable(vm.envAddress("CONTRACT_ADDRESS")));
        address resolver = vm.envAddress("RESOLVER_ADDRESS");
        address owner    = vm.envAddress("OWNER_ADDRESS");

        console.log("contract        :", address(footmon));
        console.log("owner           :", footmon.owner());
        console.log("resolver        :", footmon.resolver());
        console.log("duelHousePct    :", footmon.duelHousePct());
        console.log("duelExpiry      :", footmon.duelExpiry());
        console.log("duelsPaused     :", footmon.duelsPaused());
        console.log("totalEscrowed   :", footmon.totalEscrowed());
        console.log("pendingClaims   :", footmon.totalPendingClaims());
        console.log("houseBalance    :", footmon.houseBalance());
        console.log("balance         :", address(footmon).balance);
        console.log("freeBalance     :", footmon.freeBalance());

        require(footmon.resolver() == resolver, "resolver() mismatch");
        require(footmon.owner() == owner,       "owner() mismatch");
        require(!footmon.duelsPaused(),         "duels are paused");
        require(footmon.duelHousePct() <= 50,   "house pct out of bounds");

        // Solvency: the contract must always hold what it owes.
        uint256 owed = footmon.totalEscrowed()
            + footmon.totalPendingClaims()
            + footmon.prizePool()
            + footmon.houseBalance();
        require(address(footmon).balance >= owed, "INSOLVENT");

        console.log("");
        console.log("OK: live contract matches local env and is solvent.");
    }
}
