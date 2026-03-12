/**
 * Concurrent Users Deposit + Sequential Withdrawal Test on Plasma Testnet
 *
 * Test plan:
 *   1. Setup — Create 3 fresh users (A, B, C), fund them with XPL and USDT
 *   2. Concurrent Deposits — All 3 users deposit 1 USDT each via Promise.all
 *   3. Sequential Withdrawals — Each user withdraws 1 USDT to a fresh recipient
 *      (must be sequential because each withdrawal changes the state tree)
 *   4. Verify — Check all 3 recipients got 1 USDT, all nullifiers are unique
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
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
  "function mint(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
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
  withdrawAmount: bigint;
  recipientAddress: Address;
  depositBlockNumber: bigint;
}) {
  const {
    commitment, label, value, nullifier, secret,
    masterNullifier, masterSecret,
    withdrawAmount, recipientAddress, depositBlockNumber,
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

  // Publish ASP root (deployer has POSTMAN role)
  const fakeCID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const updateTx = await deployerWallet.writeContract({
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
  const newNullifier = hashPoseidon([masterNullifier, label, 0n]);
  const newSecret = hashPoseidon([masterSecret, label, 0n]);

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

  // Extract spent nullifier from Withdrawn event
  const withdrawnLogs = await publicClient.getLogs({
    address: USDT_POOL,
    event: { type: "event", name: "Withdrawn", inputs: [
      { name: "_processooor", type: "address", indexed: true },
      { name: "_value", type: "uint256", indexed: false },
      { name: "_spentNullifier", type: "uint256", indexed: false },
      { name: "_newCommitment", type: "uint256", indexed: false },
    ]},
    fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
  });
  const spentNullifier = withdrawnLogs.length > 0 ? withdrawnLogs[withdrawnLogs.length - 1].args._spentNullifier! : 0n;

  return { relayTx, receipt, changeAmount, publicSignals, spentNullifier };
}

// ============ USER TYPE ============
interface UserInfo {
  name: string;
  privateKey: Hex;
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: ReturnType<typeof createWalletClient>;
  recipientKey: Hex;
  recipientAddress: Address;
  masterNullifier: bigint;
  masterSecret: bigint;
  nullifier: bigint;
  secret: bigint;
  precommitment: bigint;
  depositAmount: bigint;
  // Filled after deposit
  commitment: bigint;
  label: bigint;
  value: bigint;
  depositBlockNumber: bigint;
}

// ============ MAIN TEST ============
async function main() {
  console.log("=".repeat(70));
  console.log("Concurrent Users Deposit + Sequential Withdrawal Test");
  console.log("Plasma Testnet (Chain 9746)");
  console.log("=".repeat(70));
  console.log(`Deployer: ${deployerAccount.address}`);
  console.log(`Relayer:  ${relayerAccount.address}`);
  console.log();

  const scope = await publicClient.readContract({ address: USDT_POOL, abi: POOL_ABI, functionName: "SCOPE" });
  console.log(`Pool scope: ${scope}`);
  console.log();

  // ================================================================
  // STEP 1: Setup — Create 3 fresh users, fund them with XPL + USDT
  // ================================================================
  console.log("=== STEP 1: Setup — Create and Fund 3 Users ===");

  const userNames = ["User A", "User B", "User C"];
  const userSeeds = [
    { nullSeed: 300001n, secSeed: 400001n },
    { nullSeed: 300002n, secSeed: 400002n },
    { nullSeed: 300003n, secSeed: 400003n },
  ];

  const users: UserInfo[] = [];

  for (let i = 0; i < 3; i++) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({ chain: plasmaTestnet, transport: http(RPC), account });

    const recipientKey = generatePrivateKey();
    const recipientAccount = privateKeyToAccount(recipientKey);

    const masterNullifier = hashPoseidon([userSeeds[i].nullSeed]);
    const masterSecret = hashPoseidon([userSeeds[i].secSeed]);
    const depositIndex = BigInt(Date.now()) + BigInt(i * 1000); // unique per user
    const nullifier = hashPoseidon([masterNullifier, scope, depositIndex]);
    const secret = hashPoseidon([masterSecret, scope, depositIndex]);
    const precommitment = hashPoseidon([nullifier, secret]);

    users.push({
      name: userNames[i],
      privateKey,
      account,
      wallet,
      recipientKey,
      recipientAddress: recipientAccount.address,
      masterNullifier,
      masterSecret,
      nullifier,
      secret,
      precommitment,
      depositAmount: 1_000_000n, // 1 USDT each
      // Placeholder values, filled after deposit
      commitment: 0n,
      label: 0n,
      value: 0n,
      depositBlockNumber: 0n,
    });

    console.log(`\n${userNames[i]}:`);
    console.log(`  Address:   ${account.address}`);
    console.log(`  Recipient: ${recipientAccount.address}`);
    console.log(`  Precommitment: ${precommitment}`);
  }

  // Fund each user with XPL for gas (0.1 XPL each)
  console.log("\nFunding users with XPL for gas...");
  for (const user of users) {
    const fundTx = await deployerWallet.sendTransaction({
      to: user.account.address,
      value: 100000000000000000n, // 0.1 XPL
    });
    await publicClient.waitForTransactionReceipt({ hash: fundTx });
    console.log(`  ${user.name}: funded 0.1 XPL (${fundTx})`);
  }

  // Mint USDT to each user (2 USDT each, more than enough for 1 USDT deposit)
  console.log("\nMinting USDT to each user...");
  for (const user of users) {
    const mintTx = await deployerWallet.writeContract({
      address: USDT, abi: ERC20_ABI, functionName: "mint",
      args: [user.account.address, 2_000_000n], // 2 USDT
    });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    const bal = await publicClient.readContract({
      address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [user.account.address],
    });
    console.log(`  ${user.name}: minted 2 USDT, balance: ${formatUnits(bal, 6)} USDT`);
  }

  console.log("\nSetup complete.\n");

  // ================================================================
  // STEP 2: Concurrent Deposits — All 3 users deposit 1 USDT each
  // ================================================================
  console.log("=== STEP 2: Concurrent Deposits — 3 Users x 1 USDT ===");
  console.log("All 3 users depositing concurrently via Promise.all...\n");

  const depositPromises = users.map(async (user) => {
    // Approve
    console.log(`  ${user.name}: approving USDT...`);
    const approveTx = await user.wallet.writeContract({
      address: USDT, abi: ERC20_ABI, functionName: "approve",
      args: [ENTRYPOINT, user.depositAmount * 10n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`  ${user.name}: approved (${approveTx})`);

    // Deposit
    console.log(`  ${user.name}: depositing ${Number(user.depositAmount) / 1e6} USDT...`);
    const depositTx = await user.wallet.writeContract({
      address: ENTRYPOINT, abi: ENTRYPOINT_ABI, functionName: "deposit",
      args: [USDT, user.depositAmount, user.precommitment], value: 0n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log(`  ${user.name}: deposited in block ${receipt.blockNumber} (${depositTx})`);
    return { user, receipt, depositTx };
  });

  const depositResults = await Promise.all(depositPromises);
  console.log("\nAll 3 deposits confirmed!");

  // Parse deposit events from each user's own transaction receipt
  console.log("\nParsing deposit events...");
  const depositedEventAbi = parseAbi([
    "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
  ]);
  for (const { user, receipt } of depositResults) {
    // Decode logs directly from this user's tx receipt — avoids cross-user confusion
    const depositLog = receipt.logs
      .map((log: any) => {
        try {
          return decodeEventLog({ abi: depositedEventAbi, data: log.data, topics: log.topics });
        } catch { return null; }
      })
      .find((decoded: any) => decoded?.eventName === "Deposited");

    if (!depositLog) {
      throw new Error(`${user.name}: No Deposited event in tx receipt`);
    }

    const onChainCommitment = depositLog.args._commitment as bigint;
    const label = depositLog.args._label as bigint;
    const onChainValue = depositLog.args._value as bigint;

    // Verify commitment
    const expectedCommitment = hashPoseidon([onChainValue, label, user.precommitment]);
    if (onChainCommitment !== expectedCommitment) {
      throw new Error(`${user.name}: commitment mismatch!`);
    }

    user.commitment = onChainCommitment;
    user.label = label;
    user.value = onChainValue;
    user.depositBlockNumber = receipt.blockNumber;

    console.log(`  ${user.name}:`);
    console.log(`    commitment: ${onChainCommitment}`);
    console.log(`    label:      ${label}`);
    console.log(`    value:      ${onChainValue} (${Number(onChainValue) / 1e6} USDT)`);
    console.log(`    block:      ${receipt.blockNumber}`);
    console.log(`    commitment verified: PASS`);
  }

  console.log();

  // ================================================================
  // STEP 3: Sequential Withdrawals — Each user withdraws 1 USDT
  // ================================================================
  console.log("=== STEP 3: Sequential Withdrawals — Each User Withdraws 1 USDT ===");
  console.log("(Sequential because each withdrawal changes the state tree)\n");

  const withdrawalResults: { user: UserInfo; spentNullifier: bigint; relayTx: Hex }[] = [];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    console.log(`--- Withdrawal ${i + 1}/3: ${user.name} -> ${user.recipientAddress} ---`);
    console.log(`  Withdrawing full ${Number(user.value) / 1e6} USDT`);

    const result = await generateProofAndRelay({
      commitment: user.commitment,
      label: user.label,
      value: user.value,
      nullifier: user.nullifier,
      secret: user.secret,
      masterNullifier: user.masterNullifier,
      masterSecret: user.masterSecret,
      withdrawAmount: user.value, // Full withdrawal (0 change)
      recipientAddress: user.recipientAddress,
      depositBlockNumber: user.depositBlockNumber,
    });

    console.log(`  ${user.name}: withdrawal complete!`);
    console.log(`  Change amount: ${Number(result.changeAmount) / 1e6} USDT (should be 0)`);
    console.log(`  Spent nullifier: ${result.spentNullifier}`);

    // Check recipient balance
    const recipientBal = await publicClient.readContract({
      address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [user.recipientAddress],
    });
    console.log(`  Recipient balance: ${formatUnits(recipientBal, 6)} USDT`);
    console.log();

    withdrawalResults.push({
      user,
      spentNullifier: result.spentNullifier,
      relayTx: result.relayTx,
    });
  }

  // ================================================================
  // STEP 4: Verify — Balances and Nullifier Uniqueness
  // ================================================================
  console.log("=== STEP 4: Verification ===");

  // Check all 3 recipient balances
  console.log("Checking recipient balances...");
  let allBalancesCorrect = true;
  for (const user of users) {
    const recipientBal = await publicClient.readContract({
      address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [user.recipientAddress],
    });
    const expected = user.depositAmount; // 1 USDT
    const match = recipientBal === expected;
    if (!match) allBalancesCorrect = false;
    console.log(`  ${user.name} recipient (${user.recipientAddress}):`);
    console.log(`    Expected: ${formatUnits(expected, 6)} USDT`);
    console.log(`    Actual:   ${formatUnits(recipientBal, 6)} USDT`);
    console.log(`    Match:    ${match ? "PASS" : "FAIL"}`);
  }

  // Verify all nullifiers are unique
  console.log("\nChecking nullifier uniqueness...");
  const nullifiers = withdrawalResults.map(r => r.spentNullifier);
  const uniqueNullifiers = new Set(nullifiers.map(n => n.toString()));
  const nullifiersUnique = uniqueNullifiers.size === nullifiers.length;
  console.log(`  Nullifiers:`);
  for (let i = 0; i < withdrawalResults.length; i++) {
    console.log(`    ${withdrawalResults[i].user.name}: ${withdrawalResults[i].spentNullifier}`);
  }
  console.log(`  Total nullifiers: ${nullifiers.length}`);
  console.log(`  Unique nullifiers: ${uniqueNullifiers.size}`);
  console.log(`  All unique: ${nullifiersUnique ? "PASS" : "FAIL"}`);

  // ================================================================
  // FINAL SUMMARY
  // ================================================================
  console.log("\n" + "=".repeat(70));
  console.log("CONCURRENT USERS TEST COMPLETE!");
  console.log("=".repeat(70));
  console.log();
  console.log("Deposits (concurrent via Promise.all):");
  for (const user of users) {
    console.log(`  ${user.name}: ${Number(user.depositAmount) / 1e6} USDT -> block ${user.depositBlockNumber}`);
  }
  console.log();
  console.log("Withdrawals (sequential):");
  for (const wr of withdrawalResults) {
    console.log(`  ${wr.user.name}: ${Number(wr.user.value) / 1e6} USDT -> ${wr.user.recipientAddress}`);
  }
  console.log();
  console.log("Verification:");
  console.log(`  All balances correct: ${allBalancesCorrect ? "PASS" : "FAIL"}`);
  console.log(`  All nullifiers unique: ${nullifiersUnique ? "PASS" : "FAIL"}`);
  console.log(`  Overall: ${allBalancesCorrect && nullifiersUnique ? "ALL PASSED" : "SOME FAILED"}`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err);
  process.exit(1);
});
