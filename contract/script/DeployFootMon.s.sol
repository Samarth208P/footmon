// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {FootMon} from "../FootMon.sol";

/**
 * @title DeployFootMon
 * @notice Deploys FootMon and points it at the server-held resolver.
 *
 * Usage:
 *   forge script contract/script/DeployFootMon.s.sol:DeployFootMon \
 *     --rpc-url $MONAD_RPC_URL --broadcast
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY  becomes owner()
 *   RESOLVER_ADDRESS      becomes resolver()
 */
contract DeployFootMon is Script {
    function run() external returns (FootMon footmon) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address resolver    = vm.envAddress("RESOLVER_ADDRESS");
        address deployer    = vm.addr(deployerKey);

        require(resolver != address(0), "RESOLVER_ADDRESS unset");

        vm.startBroadcast(deployerKey);

        footmon = new FootMon();

        // Constructor defaults resolver to the deployer; hand it to the server
        // identity so contract ownership and match adjudication stay separate.
        if (footmon.resolver() != resolver) {
            footmon.setResolver(resolver);
        }

        vm.stopBroadcast();

        console.log("FootMon deployed :", address(footmon));
        console.log("owner            :", footmon.owner());
        console.log("resolver         :", footmon.resolver());
        console.log("deployer         :", deployer);
        console.log("duelHousePct     :", footmon.duelHousePct());
        console.log("duelExpiry       :", footmon.duelExpiry());

        require(footmon.owner() == deployer, "owner mismatch");
        require(footmon.resolver() == resolver, "resolver mismatch");
    }
}
