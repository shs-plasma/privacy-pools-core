import { defineChain, type Address } from "viem";

export const PLASMA_RPC_URL =
  "https://thrumming-omniscient-fog.plasma-testnet.quiknode.pro/9e0462e2221113510287509d9ae53f6ade38e93b/";

export const PLASMA_CHAIN = defineChain({
  id: 9746,
  name: "Plasma Testnet",
  nativeCurrency: {
    name: "XPL",
    symbol: "XPL",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [PLASMA_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Plasma Explorer",
      url: "https://testnet-explorer.plasma.to",
    },
  },
});

export const PLASMA_CONTRACTS = {
  entrypoint: "0x40a16921be84B19675D26ef2215aF30F7534EEfB" as Address,
  usdtPool: "0x25F1fD54F5f813b282eD719c603CfaCa8f2A48F6" as Address,
  usdt: "0x5e8135210b6C974F370e86139Ed22Af932a4d022" as Address,
} as const;

export const RELAYER_ADDRESS =
  "0x8CB4E5200c018032fa2cc2898D0Fe62f6970556D" as Address;

export const DEPLOY_BLOCK = 17346012n;

export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const DEFAULT_HELPER_URL = "http://127.0.0.1:8787";
export const DEFAULT_RELAYER_URL = "http://127.0.0.1:3000";
export const FAKE_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

export const DEPOSIT_EVENT = {
  type: "event",
  name: "Deposited",
  inputs: [
    { name: "_depositor", type: "address", indexed: true },
    { name: "_commitment", type: "uint256", indexed: false },
    { name: "_label", type: "uint256", indexed: false },
    { name: "_value", type: "uint256", indexed: false },
    { name: "_precommitmentHash", type: "uint256", indexed: false },
  ],
} as const;

export const ENTRYPOINT_DEPOSIT_EVENT = {
  type: "event",
  name: "Deposited",
  inputs: [
    { name: "_depositor", type: "address", indexed: true },
    { name: "_pool", type: "address", indexed: true },
    { name: "_commitment", type: "uint256", indexed: false },
    { name: "_amount", type: "uint256", indexed: false },
  ],
} as const;

export const WITHDRAWN_EVENT = {
  type: "event",
  name: "Withdrawn",
  inputs: [
    { name: "_processooor", type: "address", indexed: true },
    { name: "_value", type: "uint256", indexed: false },
    { name: "_spentNullifier", type: "uint256", indexed: false },
    { name: "_newCommitment", type: "uint256", indexed: false },
  ],
} as const;
