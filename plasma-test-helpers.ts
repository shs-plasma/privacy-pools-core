/**
 * Shared test helpers for Plasma privacy pool E2E tests.
 *
 * Centralizes configuration, ABIs, pool state scanning, and proof
 * generation so the individual test scripts stay focused on their
 * test-specific logic.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeAbiParameters,
  keccak256,
  type Hex,
  type Address,
  getAddress,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { LeanIMT } from "@zk-kit/lean-imt";
import * as snarkjs from "snarkjs";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ============ CONFIG ============

export const PLASMA_TESTNET_RPC =
  "https://thrumming-omniscient-fog.plasma-testnet.quiknode.pro/9e0462e2221113510287509d9ae53f6ade38e93b/";

export const DEPLOYER_KEY =
  "0xc36e3569a3ecd111369cd20cacb9f51133d3463aee7ff211b3276a5c142125e4" as Hex;
export const RELAYER_KEY =
  "0xa4bdd1a0d968df2586d65086732a704756c67f7b9f7c98084714c4c2905b4871" as Hex;

export const ENTRYPOINT =
  "0x40a16921be84B19675D26ef2215aF30F7534EEfB" as Address;
export const USDT_POOL =
  "0x25F1fD54F5f813b282eD719c603CfaCa8f2A48F6" as Address;
export const USDT =
  "0x5e8135210b6C974F370e86139Ed22Af932a4d022" as Address;
export const DEPLOY_BLOCK = 17346012n;
export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const RELAYER_ADDRESS =
  "0x8CB4E5200c018032fa2cc2898D0Fe62f6970556D" as Address;

export const plasmaTestnet = defineChain({
  id: 9746,
  name: "Plasma Testnet",
  nativeCurrency: { name: "XPL", symbol: "XPL", decimals: 18 },
  rpcUrls: { default: { http: [PLASMA_TESTNET_RPC] } },
});

// ============ PRE-BUILT CLIENTS ============

export const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
export const relayerAccount = privateKeyToAccount(RELAYER_KEY);

export const publicClient = createPublicClient({
  chain: plasmaTestnet,
  transport: http(PLASMA_TESTNET_RPC),
});

export const deployerWallet = createWalletClient({
  chain: plasmaTestnet,
  transport: http(PLASMA_TESTNET_RPC),
  account: deployerAccount,
});

export const relayerWallet = createWalletClient({
  chain: plasmaTestnet,
  transport: http(PLASMA_TESTNET_RPC),
  account: relayerAccount,
});

// ============ ABIs ============

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function mint(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);

export const ENTRYPOINT_ABI = parseAbi([
  "function deposit(address _asset, uint256 _value, uint256 _precommitment) payable returns (uint256)",
  "function updateRoot(uint256 _root, string _ipfsCID) returns (uint256)",
  "function latestRoot() view returns (uint256)",
]);

export const POOL_ABI = parseAbi([
  "function SCOPE() view returns (uint256)",
  "function withdraw((address processooor, bytes data), (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[8] pubSignals)) external",
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
]);

export const RELAY_ABI = parseAbi([
  "function relay((address processooor, bytes data), (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[8] pubSignals), uint256 scope) external",
]);

// ============ HELPERS ============

export function hashPoseidon(inputs: bigint[]): bigint {
  return poseidon(inputs) as bigint;
}

// SDK artifacts — resolve once relative to this file
const __filename_h = fileURLToPath(import.meta.url);
const __dirname_h = path.dirname(__filename_h);

const sdkArtifacts = path.join(
  __dirname_h,
  "packages/contracts/node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts",
);
export const wasmPath = path.join(sdkArtifacts, "withdraw.wasm");
export const zkeyPath = path.join(sdkArtifacts, "withdraw.zkey");
export const vkeyPath = path.join(sdkArtifacts, "withdraw.vkey");

export const FAKE_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

// ============ POOL STATE SCANNER ============

export interface LeafEntry {
  commitment: bigint;
  blockNumber: bigint;
  logIndex: number;
  source: string;
}

export async function scanPoolState(upToBlock: bigint): Promise<{
  leaves: bigint[];
  labels: bigint[];
}> {
  const allLeaves: LeafEntry[] = [];
  const allLabels: bigint[] = [];
  const CHUNK = 9999n;

  for (let from = DEPLOY_BLOCK; from <= upToBlock; from += CHUNK + 1n) {
    const to = from + CHUNK > upToBlock ? upToBlock : from + CHUNK;

    const depositLogs = await publicClient.getLogs({
      address: USDT_POOL,
      event: {
        type: "event",
        name: "Deposited",
        inputs: [
          { name: "_depositor", type: "address", indexed: true },
          { name: "_commitment", type: "uint256", indexed: false },
          { name: "_label", type: "uint256", indexed: false },
          { name: "_value", type: "uint256", indexed: false },
          { name: "_precommitmentHash", type: "uint256", indexed: false },
        ],
      },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of depositLogs) {
      allLeaves.push({
        commitment: log.args._commitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        source: "Deposited",
      });
      allLabels.push(log.args._label!);
    }

    const withdrawnLogs = await publicClient.getLogs({
      address: USDT_POOL,
      event: {
        type: "event",
        name: "Withdrawn",
        inputs: [
          { name: "_processooor", type: "address", indexed: true },
          { name: "_value", type: "uint256", indexed: false },
          { name: "_spentNullifier", type: "uint256", indexed: false },
          { name: "_newCommitment", type: "uint256", indexed: false },
        ],
      },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of withdrawnLogs) {
      allLeaves.push({
        commitment: log.args._newCommitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        source: "Withdrawn",
      });
    }
  }

  allLeaves.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  return { leaves: allLeaves.map((e) => e.commitment), labels: allLabels };
}

// ============ PROOF GENERATION + RELAY ============

export interface ProofRelayParams {
  commitment: bigint;
  label: bigint;
  value: bigint;
  nullifier: bigint;
  secret: bigint;
  masterNullifier: bigint;
  masterSecret: bigint;
  newNullifierOverride?: bigint;
  newSecretOverride?: bigint;
  withdrawAmount: bigint;
  recipientAddress: Address;
  /** Wallet used for updateRoot tx — must have permission */
  rootUpdaterWallet: ReturnType<typeof createWalletClient>;
  depositBlockNumber: bigint;
}

export interface ProofRelayResult {
  relayTx: Hex;
  receipt: any;
  changeAmount: bigint;
  newNullifier: bigint;
  newSecret: bigint;
  publicSignals: string[];
}

export async function generateProofAndRelay(
  params: ProofRelayParams,
): Promise<ProofRelayResult> {
  const {
    commitment,
    label,
    value,
    nullifier,
    secret,
    masterNullifier,
    masterSecret,
    newNullifierOverride,
    newSecretOverride,
    withdrawAmount,
    recipientAddress,
    rootUpdaterWallet,
    depositBlockNumber,
  } = params;

  const scope = await publicClient.readContract({
    address: USDT_POOL,
    abi: POOL_ABI,
    functionName: "SCOPE",
  });

  // Build ASP tree
  const aspTree = new LeanIMT<bigint>((a: bigint, b: bigint) =>
    hashPoseidon([a, b]),
  );
  const currentBlock = await publicClient.getBlockNumber();
  const scanTo =
    currentBlock >= depositBlockNumber ? currentBlock : depositBlockNumber;
  const { leaves: stateLeaves, labels: allLabels } =
    await scanPoolState(scanTo);

  for (const l of allLabels) aspTree.insert(l);
  if (aspTree.indexOf(label) === -1) {
    console.log(`  WARNING: label not in ASP tree, inserting manually`);
    aspTree.insert(label);
  }

  const aspRoot = aspTree.root;
  const aspDepth = BigInt(aspTree.depth);

  // Publish ASP root
  const updateTx = await rootUpdaterWallet.writeContract({
    address: ENTRYPOINT,
    abi: ENTRYPOINT_ABI,
    functionName: "updateRoot",
    args: [aspRoot, FAKE_CID],
  });
  await publicClient.waitForTransactionReceipt({ hash: updateTx });
  console.log(`  ASP root published: ${updateTx}`);

  // Build state tree
  const stateTree = new LeanIMT<bigint>((a: bigint, b: bigint) =>
    hashPoseidon([a, b]),
  );
  stateTree.insertMany(stateLeaves);
  console.log(
    `  State tree: ${stateLeaves.length} leaves, depth ${stateTree.depth}`,
  );

  const stateIndex = stateTree.indexOf(commitment);
  if (stateIndex === -1) throw new Error("Commitment not found in state tree!");
  const stateMerkleProof = stateTree.generateProof(stateIndex);

  const aspIndex = aspTree.indexOf(label);
  if (aspIndex === -1) throw new Error(`Label not found in ASP tree!`);
  const aspMerkleProof = aspTree.generateProof(aspIndex);

  // Change note secrets
  const changeAmount = value - withdrawAmount;
  const newNullifier =
    newNullifierOverride ?? hashPoseidon([masterNullifier, label, 0n]);
  const newSecret =
    newSecretOverride ?? hashPoseidon([masterSecret, label, 0n]);

  // Relay context
  const withdrawalData = encodeAbiParameters(
    [
      {
        name: "RelayData",
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "relayFeeBPS", type: "uint256" },
        ],
      },
    ],
    [
      {
        recipient: recipientAddress,
        feeRecipient: RELAYER_ADDRESS,
        relayFeeBPS: 0n,
      },
    ],
  );

  const withdrawal = {
    processooor: getAddress(ENTRYPOINT),
    data: withdrawalData,
  };

  const context =
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            {
              name: "withdrawal",
              type: "tuple",
              components: [
                { name: "processooor", type: "address" },
                { name: "data", type: "bytes" },
              ],
            },
            { name: "scope", type: "uint256" },
          ],
          [
            { processooor: withdrawal.processooor, data: withdrawal.data },
            scope,
          ],
        ),
      ),
    ) % SNARK_SCALAR_FIELD;

  // Pad siblings to MAX_DEPTH
  const MAX_DEPTH = 32;
  const paddedState = [...stateMerkleProof.siblings];
  while (paddedState.length < MAX_DEPTH) paddedState.push(0n);
  const paddedASP = [...aspMerkleProof.siblings];
  while (paddedASP.length < MAX_DEPTH) paddedASP.push(0n);

  const circuitInputs = {
    withdrawnValue: withdrawAmount,
    stateRoot: stateTree.root,
    stateTreeDepth: BigInt(stateTree.depth),
    ASPRoot: aspRoot,
    ASPTreeDepth: aspDepth,
    context,
    label,
    existingValue: value,
    existingNullifier: nullifier,
    existingSecret: secret,
    newNullifier,
    newSecret,
    stateSiblings: paddedState,
    stateIndex: BigInt(stateMerkleProof.index ?? 0),
    ASPSiblings: paddedASP,
    ASPIndex: BigInt(aspMerkleProof.index ?? 0),
  };

  console.log(`  Generating Groth16 proof...`);
  console.log(
    `    withdrawnValue: ${withdrawAmount} (${Number(withdrawAmount) / 1e6} USDT)`,
  );
  console.log(
    `    existingValue:  ${value} (${Number(value) / 1e6} USDT)`,
  );
  console.log(
    `    changeAmount:   ${changeAmount} (${Number(changeAmount) / 1e6} USDT)`,
  );
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmPath,
    zkeyPath,
  );
  console.log(`  Proof generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Verify locally
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!valid) throw new Error("Proof failed local verification!");
  console.log(`  Local verification: VALID`);

  // Log public signals
  const sigLabels = [
    "newCommitmentHash",
    "existingNullifierHash",
    "withdrawnValue",
    "stateRoot",
    "stateTreeDepth",
    "ASPRoot",
    "ASPTreeDepth",
    "context",
  ];
  publicSignals.forEach((s: string, i: number) => {
    console.log(`    [${i}] ${sigLabels[i] || "?"}: ${s}`);
  });

  // Format proof for Solidity
  const formattedProof = {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])] as [
        bigint,
        bigint,
      ],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])] as [
        bigint,
        bigint,
      ],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    pubSignals: publicSignals.map((s: string) => BigInt(s)) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ],
  };

  // Relay transaction
  console.log(`  Relaying via ${relayerAccount.address}...`);
  const relayTx = await relayerWallet.writeContract({
    address: ENTRYPOINT,
    abi: RELAY_ABI,
    functionName: "relay",
    args: [withdrawal, formattedProof, scope],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: relayTx,
  });
  console.log(
    `  Relay tx: ${relayTx} (block ${receipt.blockNumber}, status: ${receipt.status})`,
  );

  return {
    relayTx,
    receipt,
    changeAmount,
    newNullifier,
    newSecret,
    publicSignals,
  };
}

// ============ PROOF-ONLY (no relay) ============

export interface ProofOnlyParams {
  commitment: bigint;
  label: bigint;
  value: bigint;
  nullifier: bigint;
  secret: bigint;
  masterNullifier: bigint;
  masterSecret: bigint;
  withdrawAmount: bigint;
  recipientAddress: Address;
  rootUpdaterWallet: ReturnType<typeof createWalletClient>;
  depositBlockNumber: bigint;
}

export interface ProofOnlyResult {
  withdrawal: { processooor: Address; data: Hex };
  formattedProof: {
    pA: [bigint, bigint];
    pB: [[bigint, bigint], [bigint, bigint]];
    pC: [bigint, bigint];
    pubSignals: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  };
  scope: bigint;
  publicSignals: string[];
  changeAmount: bigint;
  newNullifier: bigint;
  newSecret: bigint;
}

/**
 * Generates a proof without relaying — useful for the HTTP relayer test
 * where the proof is POST'd to the relayer service rather than called directly.
 */
export async function generateProofOnly(
  params: ProofOnlyParams,
): Promise<ProofOnlyResult> {
  const {
    commitment,
    label,
    value,
    nullifier,
    secret,
    masterNullifier,
    masterSecret,
    withdrawAmount,
    recipientAddress,
    rootUpdaterWallet,
    depositBlockNumber,
  } = params;

  const scope = (await publicClient.readContract({
    address: USDT_POOL,
    abi: POOL_ABI,
    functionName: "SCOPE",
  })) as bigint;

  const aspTree = new LeanIMT<bigint>((a: bigint, b: bigint) =>
    hashPoseidon([a, b]),
  );
  const currentBlock = await publicClient.getBlockNumber();
  const scanTo =
    currentBlock >= depositBlockNumber ? currentBlock : depositBlockNumber;
  const { leaves: stateLeaves, labels: allLabels } =
    await scanPoolState(scanTo);

  for (const l of allLabels) aspTree.insert(l);
  if (aspTree.indexOf(label) === -1) {
    aspTree.insert(label);
  }
  const aspRoot = aspTree.root;
  const aspDepth = BigInt(aspTree.depth);

  const updateTx = await rootUpdaterWallet.writeContract({
    address: ENTRYPOINT,
    abi: ENTRYPOINT_ABI,
    functionName: "updateRoot",
    args: [aspRoot, FAKE_CID],
  });
  await publicClient.waitForTransactionReceipt({ hash: updateTx });
  console.log(`  ASP root published: ${updateTx}`);

  const stateTree = new LeanIMT<bigint>((a: bigint, b: bigint) =>
    hashPoseidon([a, b]),
  );
  stateTree.insertMany(stateLeaves);
  console.log(
    `  State tree: ${stateLeaves.length} leaves, depth ${stateTree.depth}`,
  );

  const stateIndex = stateTree.indexOf(commitment);
  if (stateIndex === -1) throw new Error("Commitment not found in state tree!");
  const stateMerkleProof = stateTree.generateProof(stateIndex);

  const aspIndex = aspTree.indexOf(label);
  if (aspIndex === -1) throw new Error(`Label not found in ASP tree!`);
  const aspMerkleProof = aspTree.generateProof(aspIndex);

  const changeAmount = value - withdrawAmount;
  const newNullifier = hashPoseidon([masterNullifier, label, 0n]);
  const newSecret = hashPoseidon([masterSecret, label, 0n]);

  const withdrawalData = encodeAbiParameters(
    [
      {
        name: "RelayData",
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "relayFeeBPS", type: "uint256" },
        ],
      },
    ],
    [
      {
        recipient: recipientAddress,
        feeRecipient: RELAYER_ADDRESS,
        relayFeeBPS: 0n,
      },
    ],
  );

  const withdrawal = {
    processooor: getAddress(ENTRYPOINT),
    data: withdrawalData,
  } as { processooor: Address; data: Hex };

  const context =
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            {
              name: "withdrawal",
              type: "tuple",
              components: [
                { name: "processooor", type: "address" },
                { name: "data", type: "bytes" },
              ],
            },
            { name: "scope", type: "uint256" },
          ],
          [
            { processooor: withdrawal.processooor, data: withdrawal.data },
            scope,
          ],
        ),
      ),
    ) % SNARK_SCALAR_FIELD;

  const MAX_DEPTH = 32;
  const paddedState = [...stateMerkleProof.siblings];
  while (paddedState.length < MAX_DEPTH) paddedState.push(0n);
  const paddedASP = [...aspMerkleProof.siblings];
  while (paddedASP.length < MAX_DEPTH) paddedASP.push(0n);

  const circuitInputs = {
    withdrawnValue: withdrawAmount,
    stateRoot: stateTree.root,
    stateTreeDepth: BigInt(stateTree.depth),
    ASPRoot: aspRoot,
    ASPTreeDepth: aspDepth,
    context,
    label,
    existingValue: value,
    existingNullifier: nullifier,
    existingSecret: secret,
    newNullifier,
    newSecret,
    stateSiblings: paddedState,
    stateIndex: BigInt(stateMerkleProof.index ?? 0),
    ASPSiblings: paddedASP,
    ASPIndex: BigInt(aspMerkleProof.index ?? 0),
  };

  console.log(`  Generating Groth16 proof...`);
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmPath,
    zkeyPath,
  );
  console.log(`  Proof generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!valid) throw new Error("Proof failed local verification!");
  console.log(`  Local verification: VALID`);

  const formattedProof = {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])] as [
        bigint,
        bigint,
      ],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])] as [
        bigint,
        bigint,
      ],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    pubSignals: publicSignals.map((s: string) => BigInt(s)) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ],
  };

  return {
    withdrawal,
    formattedProof,
    scope,
    publicSignals,
    changeAmount,
    newNullifier,
    newSecret,
  };
}
