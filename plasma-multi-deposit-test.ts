/**
 * Multi-Deposit + Partial Withdrawal Test on Plasma Testnet
 *
 * Test plan:
 *   1. Setup — deployer key, mint USDT
 *   2. Three Deposits — 1, 2, 3 USDT into the pool
 *   3. Partial Withdrawal — withdraw 1.5 USDT from the 2 USDT deposit (0.5 USDT change)
 *   4. Withdraw Change Note — withdraw the remaining 0.5 USDT from the change note
 *   5. Full Withdrawal — withdraw the full 1 USDT from deposit #1
 *   6. Verify Balances — recipient should have 1.5 + 0.5 + 1.0 = 3 USDT total
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
  numberToHex,
  formatUnits,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { LeanIMT } from "@zk-kit/lean-imt";
import * as snarkjs from "snarkjs";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ CONFIG ============
const RPC = "https://thrumming-omniscient-fog.plasma-testnet.quiknode.pro/9e0462e2221113510287509d9ae53f6ade38e93b/";
const DEPLOYER_KEY = "0xc36e3569a3ecd111369cd20cacb9f51133d3463aee7ff211b3276a5c142125e4" as Hex;
const RELAYER_KEY = "0xa4bdd1a0d968df2586d65086732a704756c67f7b9f7c98084714c4c2905b4871" as Hex;

// Contracts
const ENTRYPOINT = "0x40a16921be84B19675D26ef2215aF30F7534EEfB" as Address;
const USDT_POOL = "0x25F1fD54F5f813b282eD719c603CfaCa8f2A48F6" as Address;
const USDT = "0x5e8135210b6C974F370e86139Ed22Af932a4d022" as Address;
const DEPLOY_BLOCK = 17346012n;
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const RELAYER_ADDRESS = "0x8CB4E5200c018032fa2cc2898D0Fe62f6970556D" as Address;

const plasmaTestnet = defineChain({
  id: 9746,
  name: "Plasma Testnet",
  nativeCurrency: { name: "XPL", symbol: "XPL", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

// ============ CLIENTS ============
const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
const relayerAccount = privateKeyToAccount(RELAYER_KEY);
const publicClient = createPublicClient({ chain: plasmaTestnet, transport: http(RPC) });
const deployerWallet = createWalletClient({ chain: plasmaTestnet, transport: http(RPC), account: deployerAccount });
const relayerWallet = createWalletClient({ chain: plasmaTestnet, transport: http(RPC), account: relayerAccount });

// ============ ABIs ============
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function mint(address, uint256) returns (bool)",
]);

const ENTRYPOINT_ABI = parseAbi([
  "function deposit(address _asset, uint256 _value, uint256 _precommitment) payable returns (uint256)",
  "function updateRoot(uint256 _root, string _ipfsCID) returns (uint256)",
  "function latestRoot() view returns (uint256)",
]);

const POOL_ABI = parseAbi([
  "function SCOPE() view returns (uint256)",
  "function withdraw((address processooor, bytes data), (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[8] pubSignals)) external",
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
]);

const RELAY_ABI = parseAbi([
  "function relay((address processooor, bytes data), (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[8] pubSignals), uint256 scope) external",
]);

// ============ HELPER FUNCTIONS ============
function hashPoseidon(inputs: bigint[]): bigint {
  return poseidon(inputs) as bigint;
}

// SDK artifacts
const sdkArtifacts = path.join(__dirname, "packages/contracts/node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts");
const wasmPath = path.join(sdkArtifacts, "withdraw.wasm");
const zkeyPath = path.join(sdkArtifacts, "withdraw.zkey");
const vkeyPath = path.join(sdkArtifacts, "withdraw.vkey");

// ============ POOL STATE SCANNER ============
async function scanPoolState(upToBlock: bigint) {
  const allLeaves: { commitment: bigint; blockNumber: bigint; logIndex: number; source: string }[] = [];
  const allLabels: bigint[] = [];
  const CHUNK = 9999n;

  for (let from = DEPLOY_BLOCK; from <= upToBlock; from += CHUNK + 1n) {
    const to = from + CHUNK > upToBlock ? upToBlock : from + CHUNK;

    const depositLogs = await publicClient.getLogs({
      address: USDT_POOL,
      event: { type: "event", name: "Deposited", inputs: [
        { name: "_depositor", type: "address", indexed: true },
        { name: "_commitment", type: "uint256", indexed: false },
        { name: "_label", type: "uint256", indexed: false },
        { name: "_value", type: "uint256", indexed: false },
        { name: "_precommitmentHash", type: "uint256", indexed: false },
      ]},
      fromBlock: from, toBlock: to,
    });
    for (const log of depositLogs) {
      allLeaves.push({ commitment: log.args._commitment!, blockNumber: log.blockNumber, logIndex: log.logIndex, source: "Deposited" });
      allLabels.push(log.args._label!);
    }

    const withdrawnLogs = await publicClient.getLogs({
      address: USDT_POOL,
      event: { type: "event", name: "Withdrawn", inputs: [
        { name: "_processooor", type: "address", indexed: true },
        { name: "_value", type: "uint256", indexed: false },
        { name: "_spentNullifier", type: "uint256", indexed: false },
        { name: "_newCommitment", type: "uint256", indexed: false },
      ]},
      fromBlock: from, toBlock: to,
    });
    for (const log of withdrawnLogs) {
      allLeaves.push({ commitment: log.args._newCommitment!, blockNumber: log.blockNumber, logIndex: log.logIndex, source: "Withdrawn" });
    }
  }

  allLeaves.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  return { leaves: allLeaves.map(e => e.commitment), labels: allLabels };
}

// ============ PROOF GENERATION + RELAY ============
async function generateProofAndRelay(params: {
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
  depositorWallet: ReturnType<typeof createWalletClient>;
  depositBlockNumber: bigint;
}) {
  const {
    commitment, label, value, nullifier, secret,
    masterNullifier, masterSecret,
    newNullifierOverride, newSecretOverride,
    withdrawAmount, recipientAddress, depositorWallet, depositBlockNumber,
  } = params;

  const scope = await publicClient.readContract({ address: USDT_POOL, abi: POOL_ABI, functionName: "SCOPE" });

  // Build ASP tree
  const aspTree = new LeanIMT<bigint>((a: bigint, b: bigint) => hashPoseidon([a, b]));
  const currentBlock = await publicClient.getBlockNumber();
  const scanTo = currentBlock >= depositBlockNumber ? currentBlock : depositBlockNumber;
  const { leaves: stateLeaves, labels: allLabels } = await scanPoolState(scanTo);

  for (const l of allLabels) aspTree.insert(l);
  if (aspTree.indexOf(label) === -1) {
    console.log(`  WARNING: label not in ASP tree, inserting manually`);
    aspTree.insert(label);
  }

  const aspRoot = aspTree.root;
  const aspDepth = BigInt(aspTree.depth);

  // Publish ASP root
  const fakeCID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const updateTx = await depositorWallet.writeContract({
    address: ENTRYPOINT, abi: ENTRYPOINT_ABI, functionName: "updateRoot", args: [aspRoot, fakeCID],
  });
  await publicClient.waitForTransactionReceipt({ hash: updateTx });
  console.log(`  ASP root published: ${updateTx}`);

  // Build state tree
  const stateTree = new LeanIMT<bigint>((a: bigint, b: bigint) => hashPoseidon([a, b]));
  stateTree.insertMany(stateLeaves);
  console.log(`  State tree: ${stateLeaves.length} leaves, depth ${stateTree.depth}`);

  const stateIndex = stateTree.indexOf(commitment);
  if (stateIndex === -1) throw new Error("Commitment not found in state tree!");
  const stateMerkleProof = stateTree.generateProof(stateIndex);

  const aspIndex = aspTree.indexOf(label);
  if (aspIndex === -1) throw new Error(`Label not found in ASP tree!`);
  const aspMerkleProof = aspTree.generateProof(aspIndex);

  // Withdrawal secrets for change note
  const changeAmount = value - withdrawAmount;
  const newNullifier = newNullifierOverride ?? hashPoseidon([masterNullifier, label, 0n]);
  const newSecret = newSecretOverride ?? hashPoseidon([masterSecret, label, 0n]);

  // Relay context
  const withdrawalData = encodeAbiParameters(
    [{ name: "RelayData", type: "tuple", components: [
      { name: "recipient", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "relayFeeBPS", type: "uint256" },
    ]}],
    [{ recipient: recipientAddress, feeRecipient: RELAYER_ADDRESS, relayFeeBPS: 0n }],
  );

  const withdrawal = { processooor: getAddress(ENTRYPOINT), data: withdrawalData };

  const context = BigInt(keccak256(encodeAbiParameters(
    [
      { name: "withdrawal", type: "tuple", components: [
        { name: "processooor", type: "address" },
        { name: "data", type: "bytes" },
      ]},
      { name: "scope", type: "uint256" },
    ],
    [{ processooor: withdrawal.processooor, data: withdrawal.data }, scope],
  ))) % SNARK_SCALAR_FIELD;

  // Pad siblings
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
    label, existingValue: value,
    existingNullifier: nullifier, existingSecret: secret,
    newNullifier, newSecret,
    stateSiblings: paddedState,
    stateIndex: BigInt(stateMerkleProof.index ?? 0),
    ASPSiblings: paddedASP,
    ASPIndex: BigInt(aspMerkleProof.index ?? 0),
  };

  console.log(`  Generating Groth16 proof...`);
  console.log(`    withdrawnValue: ${withdrawAmount} (${Number(withdrawAmount) / 1e6} USDT)`);
  console.log(`    existingValue:  ${value} (${Number(value) / 1e6} USDT)`);
  console.log(`    changeAmount:   ${changeAmount} (${Number(changeAmount) / 1e6} USDT)`);
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInputs, wasmPath, zkeyPath);
  console.log(`  Proof generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Verify locally
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!valid) throw new Error("Proof failed local verification!");
  console.log(`  Local verification: VALID`);

  // Log public signals
  const sigLabels = ["newCommitmentHash", "existingNullifierHash", "withdrawnValue", "stateRoot", "stateTreeDepth", "ASPRoot", "ASPTreeDepth", "context"];
  publicSignals.forEach((s: string, i: number) => {
    console.log(`    [${i}] ${sigLabels[i] || "?"}: ${s}`);
  });

  // Format and relay
  const formattedProof = {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])] as [bigint, bigint],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])] as [bigint, bigint],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    pubSignals: publicSignals.map((s: string) => BigInt(s)) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
  };

  console.log(`  Relaying via ${relayerAccount.address}...`);
  const relayTx = await relayerWallet.writeContract({
    address: ENTRYPOINT, abi: RELAY_ABI, functionName: "relay",
    args: [withdrawal, formattedProof, scope],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: relayTx });
  console.log(`  Relay tx: ${relayTx} (block ${receipt.blockNumber}, status: ${receipt.status})`);

  return { relayTx, receipt, changeAmount, newNullifier, newSecret, publicSignals };
}

// ============ MAIN TEST ============
async function main() {
  console.log("=".repeat(70));
  console.log("Multi-Deposit + Partial Withdrawal Test — Plasma Testnet (Chain 9746)");
  console.log("=".repeat(70));
  console.log(`Deployer:  ${deployerAccount.address}`);
  console.log(`Relayer:   ${relayerAccount.address}`);
  console.log();

  // Generate a fresh recipient address for withdrawals
  const recipientKey = generatePrivateKey();
  const recipientAccount = privateKeyToAccount(recipientKey);
  const recipientAddress = recipientAccount.address;
  console.log(`Recipient: ${recipientAddress} (fresh address for all withdrawals)`);
  console.log();

  // ================================================================
  // STEP 1: Setup — Mint USDT if needed, approve entrypoint
  // ================================================================
  console.log("=== STEP 1: Setup ===");

  const scope = await publicClient.readContract({ address: USDT_POOL, abi: POOL_ABI, functionName: "SCOPE" });
  console.log(`Pool scope: ${scope}`);

  const totalNeeded = 6_000_000n; // 1 + 2 + 3 = 6 USDT
  const balance = await publicClient.readContract({
    address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [deployerAccount.address],
  });
  console.log(`Current USDT balance: ${formatUnits(balance, 6)} USDT`);

  if (balance < totalNeeded) {
    console.log(`Minting ${formatUnits(totalNeeded * 2n, 6)} USDT...`);
    const mintTx = await deployerWallet.writeContract({
      address: USDT, abi: ERC20_ABI, functionName: "mint",
      args: [deployerAccount.address, totalNeeded * 2n],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    console.log(`Minted: ${mintTx}`);
  }

  // Approve entrypoint
  const allowance = await publicClient.readContract({
    address: USDT, abi: ERC20_ABI, functionName: "allowance",
    args: [deployerAccount.address, ENTRYPOINT],
  });
  if (allowance < totalNeeded) {
    console.log("Approving USDT for Entrypoint...");
    const approveTx = await deployerWallet.writeContract({
      address: USDT, abi: ERC20_ABI, functionName: "approve",
      args: [ENTRYPOINT, totalNeeded * 100n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`Approved: ${approveTx}`);
  }

  console.log("Setup complete.\n");

  // ================================================================
  // STEP 2: Three Deposits — 1 USDT, 2 USDT, 3 USDT
  // ================================================================
  console.log("=== STEP 2: Three Deposits ===");

  // Each deposit uses different master seeds to ensure unique Poseidon secrets
  const deposits = [
    { amount: 1_000_000n, masterNullSeed: 100001n, masterSecSeed: 200001n },
    { amount: 2_000_000n, masterNullSeed: 100002n, masterSecSeed: 200002n },
    { amount: 3_000_000n, masterNullSeed: 100003n, masterSecSeed: 200003n },
  ];

  interface DepositInfo {
    amount: bigint;
    masterNullifier: bigint;
    masterSecret: bigint;
    nullifier: bigint;
    secret: bigint;
    precommitment: bigint;
    commitment: bigint;
    label: bigint;
    value: bigint;
    blockNumber: bigint;
  }

  const depositInfos: DepositInfo[] = [];

  for (let i = 0; i < deposits.length; i++) {
    const dep = deposits[i];
    console.log(`\n--- Deposit #${i + 1}: ${Number(dep.amount) / 1e6} USDT ---`);

    const masterNullifier = hashPoseidon([dep.masterNullSeed]);
    const masterSecret = hashPoseidon([dep.masterSecSeed]);
    const depositIndex = BigInt(Date.now()) + BigInt(i); // unique per deposit
    const nullifier = hashPoseidon([masterNullifier, scope, depositIndex]);
    const secret = hashPoseidon([masterSecret, scope, depositIndex]);
    const precommitment = hashPoseidon([nullifier, secret]);

    console.log(`  masterNullifier: ${masterNullifier}`);
    console.log(`  masterSecret:    ${masterSecret}`);
    console.log(`  nullifier:       ${nullifier}`);
    console.log(`  secret:          ${secret}`);
    console.log(`  precommitment:   ${precommitment}`);

    const depositTx = await deployerWallet.writeContract({
      address: ENTRYPOINT, abi: ENTRYPOINT_ABI, functionName: "deposit",
      args: [USDT, dep.amount, precommitment], value: 0n,
    });
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log(`  Deposit tx: ${depositTx} (block ${depositReceipt.blockNumber})`);

    // Parse deposit event
    const depositLogs = await publicClient.getLogs({
      address: USDT_POOL,
      event: { type: "event", name: "Deposited", inputs: [
        { name: "_depositor", type: "address", indexed: true },
        { name: "_commitment", type: "uint256", indexed: false },
        { name: "_label", type: "uint256", indexed: false },
        { name: "_value", type: "uint256", indexed: false },
        { name: "_precommitmentHash", type: "uint256", indexed: false },
      ]},
      fromBlock: depositReceipt.blockNumber, toBlock: depositReceipt.blockNumber,
    });
    const depEvent = depositLogs[depositLogs.length - 1]!;
    const onChainCommitment = depEvent.args._commitment!;
    const label = depEvent.args._label!;
    const onChainValue = depEvent.args._value!;

    // Verify commitment
    const expectedCommitment = hashPoseidon([onChainValue, label, precommitment]);
    if (onChainCommitment !== expectedCommitment) {
      throw new Error(`Deposit #${i + 1}: commitment mismatch!`);
    }

    console.log(`  commitment: ${onChainCommitment}`);
    console.log(`  label:      ${label}`);
    console.log(`  value:      ${onChainValue} (${Number(onChainValue) / 1e6} USDT)`);
    console.log(`  commitment verified: PASS`);

    depositInfos.push({
      amount: dep.amount,
      masterNullifier,
      masterSecret,
      nullifier,
      secret,
      precommitment,
      commitment: onChainCommitment,
      label,
      value: onChainValue,
      blockNumber: depositReceipt.blockNumber,
    });
  }

  console.log(`\nAll 3 deposits complete.`);
  console.log(`  Deposit #1: ${Number(depositInfos[0].amount) / 1e6} USDT`);
  console.log(`  Deposit #2: ${Number(depositInfos[1].amount) / 1e6} USDT`);
  console.log(`  Deposit #3: ${Number(depositInfos[2].amount) / 1e6} USDT`);
  console.log();

  // ================================================================
  // STEP 3: Partial Withdrawal — 1.5 USDT from deposit #2 (2 USDT)
  // ================================================================
  console.log("=== STEP 3: Partial Withdrawal — 1.5 USDT from Deposit #2 (2 USDT) ===");

  const dep2 = depositInfos[1];
  const withdrawAmount1 = 1_500_000n; // 1.5 USDT

  console.log(`  Withdrawing ${Number(withdrawAmount1) / 1e6} USDT from ${Number(dep2.value) / 1e6} USDT deposit`);
  console.log(`  Expected change: ${Number(dep2.value - withdrawAmount1) / 1e6} USDT`);

  const result1 = await generateProofAndRelay({
    commitment: dep2.commitment,
    label: dep2.label,
    value: dep2.value,
    nullifier: dep2.nullifier,
    secret: dep2.secret,
    masterNullifier: dep2.masterNullifier,
    masterSecret: dep2.masterSecret,
    withdrawAmount: withdrawAmount1,
    recipientAddress: recipientAddress,
    depositorWallet: deployerWallet,
    depositBlockNumber: dep2.blockNumber,
  });

  console.log(`\n  Partial withdrawal complete!`);
  console.log(`  Change amount: ${Number(result1.changeAmount) / 1e6} USDT`);
  console.log(`  Change note newNullifier: ${result1.newNullifier}`);
  console.log(`  Change note newSecret:    ${result1.newSecret}`);
  console.log(`  Change note commitment (newCommitmentHash): ${BigInt(result1.publicSignals[0])}`);

  // Check recipient balance after first withdrawal
  const recipientBal1 = await publicClient.readContract({
    address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [recipientAddress],
  });
  console.log(`  Recipient balance after step 3: ${formatUnits(recipientBal1, 6)} USDT`);
  console.log();

  // ================================================================
  // STEP 4: Withdraw Change Note — 0.5 USDT remaining from partial withdrawal
  // ================================================================
  console.log("=== STEP 4: Withdraw Change Note — 0.5 USDT ===");

  // The change note was created during the first withdrawal:
  //   commitment = newCommitmentHash = publicSignals[0] from step 3
  //   value = 2_000_000 - 1_500_000 = 500_000
  //   label = same label from deposit #2
  //   nullifier = newNullifier from step 3
  //   secret = newSecret from step 3
  const changeNoteCommitment = BigInt(result1.publicSignals[0]);
  const changeNoteValue = result1.changeAmount; // 500_000
  const changeNoteNullifier = result1.newNullifier;
  const changeNoteSecret = result1.newSecret;

  // For the SECOND withdrawal, we need NEW change note secrets (index 1n instead of 0n)
  const secondNewNullifier = hashPoseidon([dep2.masterNullifier, dep2.label, 1n]);
  const secondNewSecret = hashPoseidon([dep2.masterSecret, dep2.label, 1n]);

  console.log(`  Change note commitment: ${changeNoteCommitment}`);
  console.log(`  Change note value:      ${Number(changeNoteValue) / 1e6} USDT`);
  console.log(`  Change note nullifier:  ${changeNoteNullifier}`);
  console.log(`  Change note secret:     ${changeNoteSecret}`);
  console.log(`  Withdrawing full ${Number(changeNoteValue) / 1e6} USDT from change note`);

  // MUST rescan pool state after the first withdrawal to include the new commitment
  const result2 = await generateProofAndRelay({
    commitment: changeNoteCommitment,
    label: dep2.label,
    value: changeNoteValue,
    nullifier: changeNoteNullifier,
    secret: changeNoteSecret,
    masterNullifier: dep2.masterNullifier,
    masterSecret: dep2.masterSecret,
    newNullifierOverride: secondNewNullifier,
    newSecretOverride: secondNewSecret,
    withdrawAmount: changeNoteValue, // Full 0.5 USDT (0 change)
    recipientAddress: recipientAddress,
    depositorWallet: deployerWallet,
    depositBlockNumber: result1.receipt.blockNumber,
  });

  console.log(`\n  Change note withdrawal complete!`);
  console.log(`  Change amount: ${Number(result2.changeAmount) / 1e6} USDT (should be 0)`);

  // Check recipient balance after second withdrawal
  const recipientBal2 = await publicClient.readContract({
    address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [recipientAddress],
  });
  console.log(`  Recipient balance after step 4: ${formatUnits(recipientBal2, 6)} USDT`);
  console.log();

  // ================================================================
  // STEP 5: Full Withdrawal — 1 USDT from deposit #1
  // ================================================================
  console.log("=== STEP 5: Full Withdrawal — 1 USDT from Deposit #1 ===");

  const dep1 = depositInfos[0];
  console.log(`  Withdrawing full ${Number(dep1.value) / 1e6} USDT from deposit #1`);
  console.log(`  (Verifies tree state is consistent after partial withdrawals)`);

  const result3 = await generateProofAndRelay({
    commitment: dep1.commitment,
    label: dep1.label,
    value: dep1.value,
    nullifier: dep1.nullifier,
    secret: dep1.secret,
    masterNullifier: dep1.masterNullifier,
    masterSecret: dep1.masterSecret,
    withdrawAmount: dep1.value, // Full 1 USDT (0 change)
    recipientAddress: recipientAddress,
    depositorWallet: deployerWallet,
    depositBlockNumber: dep1.blockNumber,
  });

  console.log(`\n  Full withdrawal from deposit #1 complete!`);
  console.log(`  Change amount: ${Number(result3.changeAmount) / 1e6} USDT (should be 0)`);

  // Check recipient balance after third withdrawal
  const recipientBal3 = await publicClient.readContract({
    address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [recipientAddress],
  });
  console.log(`  Recipient balance after step 5: ${formatUnits(recipientBal3, 6)} USDT`);
  console.log();

  // ================================================================
  // STEP 6: Verify Final Balances
  // ================================================================
  console.log("=== STEP 6: Final Balance Verification ===");

  const finalRecipientBalance = await publicClient.readContract({
    address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [recipientAddress],
  });

  const expectedTotal = withdrawAmount1 + changeNoteValue + dep1.value; // 1.5 + 0.5 + 1.0 = 3.0 USDT
  const actualTotal = finalRecipientBalance;

  console.log(`  Withdrawal #1 (partial from dep #2): ${Number(withdrawAmount1) / 1e6} USDT`);
  console.log(`  Withdrawal #2 (change note):         ${Number(changeNoteValue) / 1e6} USDT`);
  console.log(`  Withdrawal #3 (full from dep #1):    ${Number(dep1.value) / 1e6} USDT`);
  console.log(`  -----------------------------------------------`);
  console.log(`  Expected total:  ${Number(expectedTotal) / 1e6} USDT`);
  console.log(`  Actual balance:  ${formatUnits(actualTotal, 6)} USDT`);
  console.log(`  Balance match:   ${actualTotal === expectedTotal ? "PASS" : "FAIL"}`);
  console.log();

  console.log(`  Deposit #3 (${Number(depositInfos[2].value) / 1e6} USDT) remains untouched in the pool.`);

  // ================================================================
  // FINAL SUMMARY
  // ================================================================
  console.log("\n" + "=".repeat(70));
  console.log("MULTI-DEPOSIT + PARTIAL WITHDRAWAL TEST COMPLETE!");
  console.log("=".repeat(70));
  console.log(`  Deposit #1: ${Number(depositInfos[0].amount) / 1e6} USDT -> Fully withdrawn (step 5)`);
  console.log(`  Deposit #2: ${Number(depositInfos[1].amount) / 1e6} USDT -> Partial ${Number(withdrawAmount1) / 1e6} USDT (step 3) + change ${Number(changeNoteValue) / 1e6} USDT (step 4)`);
  console.log(`  Deposit #3: ${Number(depositInfos[2].amount) / 1e6} USDT -> Untouched (still in pool)`);
  console.log(`  Recipient received: ${formatUnits(actualTotal, 6)} USDT total`);
  console.log(`  All assertions: ${actualTotal === expectedTotal ? "PASSED" : "FAILED"}`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err);
  process.exit(1);
});
