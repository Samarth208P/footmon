// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {FootMon} from "../src/FootMon.sol";

contract DeployFootMon is Script {
    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        FootMon footmon = new FootMon();

        console.log("FootMon deployed at:", address(footmon));

        vm.stopBroadcast();
    }
}
