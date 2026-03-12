// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/ERC20.sol';
import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {DeployLib} from 'contracts/lib/DeployLib.sol';
import {ICreateX} from 'interfaces/external/ICreateX.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';

/**
 * @notice Deploy a PrivacyPoolComplex for MockUSDT v2 on Plasma Testnet
 *         and register it at the existing Entrypoint.
 */
contract DeployUSDTv2Pool is Script {
  ICreateX public constant CreateX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

  // Existing deployment
  Entrypoint public entrypoint = Entrypoint(payable(0x40a16921be84B19675D26ef2215aF30F7534EEfB));
  address public withdrawalVerifier = 0x03A7AD175889b694B5005f8835C6D8A6315a399C;
  address public ragequitVerifier = 0x999a02Ff05448728160B6AD674C6785065612118;

  // MockUSDT v2 (deployed by stealth testkit)
  address public usdtV2 = 0x617BFC71cE983f856867d696a65234186bb111Db;

  function run() public {
    address deployer = vm.envAddress('DEPLOYER_ADDRESS');
    vm.startBroadcast(deployer);

    // 1. Deploy PrivacyPoolComplex for USDT v2
    bytes memory constructorArgs = abi.encode(
      address(entrypoint),
      withdrawalVerifier,
      ragequitVerifier,
      usdtV2
    );

    // Use a unique salt for this token symbol
    bytes11 tokenSalt = bytes11(keccak256(abi.encodePacked(DeployLib.COMPLEX_POOL_SALT, "USDTv2")));

    address pool = CreateX.deployCreate2(
      DeployLib.salt(deployer, tokenSalt),
      abi.encodePacked(type(PrivacyPoolComplex).creationCode, constructorArgs)
    );

    console.log("USDT v2 Pool deployed:", pool);

    // 2. Register pool at Entrypoint
    entrypoint.registerPool(
      IERC20(usdtV2),
      PrivacyPoolComplex(pool),
      1_000_000,  // minimumDepositAmount: 1 USDT (6 decimals)
      0,          // vettingFeeBPS: 0 for pilot
      0           // maxRelayFeeBPS: 0 for pilot
    );

    console.log("Pool registered at Entrypoint");
    console.log("Pool scope:", PrivacyPoolComplex(pool).SCOPE());

    vm.stopBroadcast();
  }
}
