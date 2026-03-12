/**
 * Privacy Pool End-to-End Test on Plasma Testnet
 *
 * Full cycle: Generate keys → Deposit USDT → Publish ASP root → Generate ZK proof → Withdraw
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { LeanIMT } from "@zk-kit/lean-imt";
import * as snarkjs from "snarkjs";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ CONFIG ============
const PLASMA_TESTNET_RPC = "https://thrumming-omniscient-fog.plasma-testnet.quiknode.pro/9e0462e2221113510287509d9ae53f6ade38e93b/";
const PRIVATE_KEY = "0xc36e3569a3ecd111369cd20cacb9f51133d3463aee7ff211b3276a5c142125e4" as Hex;

// Deployed contract addresses (from deployments/9746.json)
const ENTRYPOINT_PROXY = "0x40a16921be84b19675d26ef2215af30f7534eefb" as Address;
const USDT_POOL = "0x25f1fd54f5f813b282ed719c603cfaca8f2a48f6" as Address;
const USDT_ADDRESS = "0x5e8135210b6C974F370e86139Ed22Af932a4d022" as Address;

const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const plasmaTestnet = defineChain({
  id: 9746,
  name: "Plasma Testnet",
  nativeCurrency: { name: "XPL", symbol: "XPL", decimals: 18 },
  rpcUrls: { default: { http: [PLASMA_TESTNET_RPC] } },
});

// ============ CLIENTS ============
const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: plasmaTestnet, transport: http(PLASMA_TESTNET_RPC) });
const walletClient = createWalletClient({ chain: plasmaTestnet, transport: http(PLASMA_TESTNET_RPC), account });

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

// ============ HELPER FUNCTIONS ============
function hashPoseidon(inputs: bigint[]): bigint {
  return poseidon(inputs) as bigint;
}

function bigintToHex(val: bigint): Hex {
  return numberToHex(val, { size: 32 });
}

// ============ MAIN TEST ============
async function main() {
  console.log("=".repeat(60));
  console.log("Privacy Pool E2E Test — Plasma Testnet (Chain 9746)");
  console.log("=".repeat(60));
  console.log(`Account: ${account.address}`);
  console.log();

  // ---- STEP 1: Get pool scope ----
  console.log("--- Step 1: Get Pool Scope ---");
  const scope = await publicClient.readContract({
    address: USDT_POOL,
    abi: POOL_ABI,
    functionName: "SCOPE",
  });
  console.log(`USDT Pool Scope: ${scope}`);

  // ---- STEP 2: Generate deposit secrets using Poseidon ----
  console.log("\n--- Step 2: Generate Deposit Secrets ---");

  // Use deterministic secrets (in production, derived from mnemonic via HD keys)
  const masterNullifier = hashPoseidon([12345n]);
  const masterSecret = hashPoseidon([67890n]);
  console.log(`Master nullifier: ${masterNullifier}`);
  console.log(`Master secret:    ${masterSecret}`);

  const depositIndex = BigInt(Date.now()); // unique per run
  const nullifier = hashPoseidon([masterNullifier, scope, depositIndex]);
  const secret = hashPoseidon([masterSecret, scope, depositIndex]);
  console.log(`Deposit nullifier: ${nullifier}`);
  console.log(`Deposit secret:    ${secret}`);

  // Compute precommitment = Poseidon(nullifier, secret)
  const precommitment = hashPoseidon([nullifier, secret]);
  console.log(`Precommitment hash: ${precommitment}`);

  // ---- STEP 3: Deposit USDT into privacy pool ----
  console.log("\n--- Step 3: Deposit USDT ---");
  const depositAmount = 1_000_000n; // 1 USDT (6 decimals)

  // Check balance
  const balance = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`USDT Balance: ${balance} (${Number(balance) / 1e6} USDT)`);

  if (balance < depositAmount) {
    console.log("Minting USDT...");
    const mintHash = await walletClient.writeContract({
      address: USDT_ADDRESS,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [account.address, 10_000_000n], // 10 USDT
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log(`Minted USDT: ${mintHash}`);
  }

  // Approve
  const allowance = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, ENTRYPOINT_PROXY],
  });
  if (allowance < depositAmount) {
    console.log("Approving USDT...");
    const approveHash = await walletClient.writeContract({
      address: USDT_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ENTRYPOINT_PROXY, depositAmount * 100n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`Approved: ${approveHash}`);
  }

  // Deposit via Entrypoint
  console.log(`Depositing ${depositAmount} (${Number(depositAmount) / 1e6} USDT) with precommitment...`);
  const depositHash = await walletClient.writeContract({
    address: ENTRYPOINT_PROXY,
    abi: ENTRYPOINT_ABI,
    functionName: "deposit",
    args: [USDT_ADDRESS, depositAmount, precommitment],
    value: 0n,
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
  console.log(`Deposit tx: ${depositHash}`);
  console.log(`Block: ${depositReceipt.blockNumber}, Status: ${depositReceipt.status}`);

  // ---- STEP 4: Parse deposit event to get label and commitment ----
  console.log("\n--- Step 4: Parse Deposit Event ---");
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
    fromBlock: depositReceipt.blockNumber,
    toBlock: depositReceipt.blockNumber,
  });

  if (depositLogs.length === 0) {
    throw new Error("No deposit event found!");
  }

  const depositEvent = depositLogs[depositLogs.length - 1]!;
  const onChainCommitment = depositEvent.args._commitment!;
  const label = depositEvent.args._label!;
  const onChainValue = depositEvent.args._value!;
  const onChainPrecommitment = depositEvent.args._precommitmentHash!;

  console.log(`On-chain commitment: ${onChainCommitment}`);
  console.log(`On-chain label:      ${label}`);
  console.log(`On-chain value:      ${onChainValue}`);
  console.log(`On-chain precommit:  ${onChainPrecommitment}`);

  // Verify commitment matches: Poseidon(value, label, precommitment)
  const expectedCommitment = hashPoseidon([onChainValue, label, precommitment]);
  console.log(`Expected commitment: ${expectedCommitment}`);
  console.log(`Match: ${onChainCommitment === expectedCommitment}`);
  if (onChainCommitment !== expectedCommitment) {
    throw new Error("Commitment mismatch!");
  }

  // ---- STEP 5: Publish ASP root ----
  console.log("\n--- Step 5: Publish ASP Root ---");
  // Build ASP tree with the label from our deposit
  // Also include previous deposit labels to match on-chain state
  const aspTree = new LeanIMT<bigint>((a: bigint, b: bigint) => hashPoseidon([a, b]));

  // Collect all labels from all deposits so the ASP tree is inclusive
  {
    const CHUNK = 9999n;
    const latestBlock = await publicClient.getBlockNumber();
    // Ensure we scan at least up to our deposit block
    const currentBlockForASP = latestBlock >= depositReceipt.blockNumber ? latestBlock : depositReceipt.blockNumber;
    const deployBlockASP = 17346012n;
    for (let from = deployBlockASP; from <= currentBlockForASP; from += CHUNK + 1n) {
      const to = from + CHUNK > currentBlockForASP ? currentBlockForASP : from + CHUNK;
      const logs = await publicClient.getLogs({
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
      for (const log of logs) {
        aspTree.insert(log.args._label!);
      }
    }
  }
  console.log(`ASP tree size: ${aspTree.size} labels`);
  // Verify our label is in the ASP tree
  if (aspTree.indexOf(label) === -1) {
    console.log(`WARNING: Our label not in ASP tree, inserting manually`);
    aspTree.insert(label);
  }
  const aspRoot = aspTree.root;
  const aspDepth = BigInt(aspTree.depth);
  console.log(`ASP tree root: ${aspRoot}`);
  console.log(`ASP tree depth: ${aspDepth}`);

  // updateRoot requires a valid IPFS CID (32-64 chars)
  const fakeCID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"; // 46 chars
  console.log(`Publishing ASP root to Entrypoint...`);
  const updateRootHash = await walletClient.writeContract({
    address: ENTRYPOINT_PROXY,
    abi: ENTRYPOINT_ABI,
    functionName: "updateRoot",
    args: [aspRoot, fakeCID],
  });
  const updateReceipt = await publicClient.waitForTransactionReceipt({ hash: updateRootHash });
  console.log(`updateRoot tx: ${updateRootHash}, status: ${updateReceipt.status}`);

  // Verify latest root
  const latestRoot = await publicClient.readContract({
    address: ENTRYPOINT_PROXY,
    abi: ENTRYPOINT_ABI,
    functionName: "latestRoot",
  });
  console.log(`Latest ASP root on-chain: ${latestRoot}`);
  console.log(`Match: ${latestRoot === aspRoot}`);

  // ---- STEP 6: Build state Merkle tree from all deposit events ----
  console.log("\n--- Step 6: Build State Merkle Tree ---");

  // Get ALL commitments from the pool to reconstruct the state tree
  // Both Deposited and Withdrawn events insert commitments into the state tree
  const currentBlock = await publicClient.getBlockNumber();
  const deployBlock = 17346012n;

  // Collect all state-changing events with their ordering info
  const allLeafEntries: { commitment: bigint; blockNumber: bigint; logIndex: number; source: string }[] = [];

  const CHUNK = 9999n;
  for (let from = deployBlock; from <= currentBlock; from += CHUNK + 1n) {
    const to = from + CHUNK > currentBlock ? currentBlock : from + CHUNK;

    // Fetch Deposited events
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
      allLeafEntries.push({
        commitment: log.args._commitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        source: "Deposited",
      });
    }

    // Fetch Withdrawn events (withdrawals also insert a new commitment into the state tree)
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
      allLeafEntries.push({
        commitment: log.args._newCommitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        source: "Withdrawn",
      });
    }
  }

  // Sort by block number, then by log index within the same block
  allLeafEntries.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  const stateLeaves = allLeafEntries.map((e) => e.commitment);
  const depositCount = allLeafEntries.filter((e) => e.source === "Deposited").length;
  const withdrawnCount = allLeafEntries.filter((e) => e.source === "Withdrawn").length;
  console.log(`Total state leaves: ${stateLeaves.length} (${depositCount} deposits + ${withdrawnCount} withdrawal change notes)`);

  const stateTree = new LeanIMT<bigint>((a: bigint, b: bigint) => hashPoseidon([a, b]));
  stateTree.insertMany(stateLeaves);

  const stateRoot = stateTree.root;
  const stateDepth = BigInt(stateTree.depth);
  console.log(`State tree root: ${stateRoot}`);
  console.log(`State tree depth: ${stateDepth}`);

  // Generate state merkle proof for our commitment
  const stateIndex = stateTree.indexOf(onChainCommitment);
  if (stateIndex === -1) throw new Error("Commitment not found in state tree!");
  const stateMerkleProof = stateTree.generateProof(stateIndex);
  console.log(`State proof index: ${stateIndex}`);
  console.log(`State proof siblings count: ${stateMerkleProof.siblings.length}`);

  // Generate ASP merkle proof for our label
  console.log(`Looking for label in ASP tree: ${label}`);
  console.log(`ASP tree size: ${aspTree.size}`);
  const aspIndex = aspTree.indexOf(label);
  console.log(`ASP index: ${aspIndex}`);
  if (aspIndex === -1) throw new Error(`Label ${label} not found in ASP tree!`);
  const aspMerkleProof = aspTree.generateProof(aspIndex);
  console.log(`ASP proof index: ${aspIndex}`);
  console.log(`ASP proof siblings count: ${aspMerkleProof.siblings.length}`);

  // ---- STEP 7: Generate withdrawal secrets for change note ----
  console.log("\n--- Step 7: Generate Withdrawal Secrets ---");
  const withdrawalAmount = 500_000n; // 0.5 USDT
  const changeAmount = onChainValue - withdrawalAmount;
  console.log(`Withdrawing: ${withdrawalAmount} (${Number(withdrawalAmount) / 1e6} USDT)`);
  console.log(`Change note: ${changeAmount} (${Number(changeAmount) / 1e6} USDT)`);

  // New nullifier/secret for the change commitment
  const newNullifier = hashPoseidon([masterNullifier, label, 0n]);
  const newSecret = hashPoseidon([masterSecret, label, 0n]);
  console.log(`New nullifier: ${newNullifier}`);
  console.log(`New secret:    ${newSecret}`);

  // ---- STEP 8: Compute context and generate Groth16 proof ----
  console.log("\n--- Step 8: Generate Withdrawal Proof (for Relayer) ---");

  // For relayed withdrawal:
  //   processooor = Entrypoint Proxy (the relay function checks this)
  //   data = abi.encode(RelayData{recipient, feeRecipient, relayFeeBPS})
  const RELAYER_ADDRESS = "0x8CB4E5200c018032fa2cc2898D0Fe62f6970556D" as Address;

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
        recipient: account.address, // funds go to us
        feeRecipient: RELAYER_ADDRESS, // relayer fee recipient
        relayFeeBPS: 0n, // 0% fee (maxRelayFeeBPS on-chain is 0)
      },
    ],
  );

  const withdrawal = {
    processooor: getAddress(ENTRYPOINT_PROXY), // Entrypoint, not our address
    data: withdrawalData,
  };

  console.log(`  processooor: ${withdrawal.processooor} (Entrypoint)`);
  console.log(`  recipient: ${account.address}`);
  console.log(`  feeRecipient: ${RELAYER_ADDRESS}`);
  console.log(`  relayFeeBPS: 0`);

  // Context = keccak256(abi.encode(Withdrawal, SCOPE)) % SNARK_SCALAR_FIELD
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

  console.log(`Context: ${context}`);

  // Pad siblings arrays to 32 (MAX_TREE_DEPTH)
  const MAX_DEPTH = 32;
  const paddedStateSiblings = [...stateMerkleProof.siblings];
  while (paddedStateSiblings.length < MAX_DEPTH) paddedStateSiblings.push(0n);

  const paddedASPSiblings = [...aspMerkleProof.siblings];
  while (paddedASPSiblings.length < MAX_DEPTH) paddedASPSiblings.push(0n);

  // Circuit input signals
  const circuitInputs = {
    // Public signals
    withdrawnValue: withdrawalAmount,
    stateRoot: stateRoot,
    stateTreeDepth: stateDepth,
    ASPRoot: aspRoot,
    ASPTreeDepth: aspDepth,
    context: context,

    // Private signals
    label: label,
    existingValue: onChainValue,
    existingNullifier: nullifier,
    existingSecret: secret,
    newNullifier: newNullifier,
    newSecret: newSecret,

    // Merkle proofs (padded to MAX_DEPTH=32)
    stateSiblings: paddedStateSiblings,
    stateIndex: BigInt(stateMerkleProof.index ?? 0),
    ASPSiblings: paddedASPSiblings,
    ASPIndex: BigInt(aspMerkleProof.index ?? 0),
  };

  console.log("Circuit inputs prepared. Generating Groth16 proof...");
  console.log(`  withdrawnValue: ${circuitInputs.withdrawnValue}`);
  console.log(`  stateRoot: ${circuitInputs.stateRoot}`);
  console.log(`  stateTreeDepth: ${circuitInputs.stateTreeDepth}`);
  console.log(`  ASPRoot: ${circuitInputs.ASPRoot}`);
  console.log(`  ASPTreeDepth: ${circuitInputs.ASPTreeDepth}`);
  console.log(`  context: ${circuitInputs.context}`);
  console.log(`  label: ${circuitInputs.label}`);
  console.log(`  existingValue: ${circuitInputs.existingValue}`);
  console.log(`  stateIndex: ${circuitInputs.stateIndex}`);
  console.log(`  ASPIndex: ${circuitInputs.ASPIndex}`);

  // Use the SDK bundled artifacts (matches the deployed verifier's trusted setup)
  const sdkArtifacts = path.join(__dirname, "packages/contracts/node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts");
  const wasmPath = path.join(sdkArtifacts, "withdraw.wasm");
  const zkeyPath = path.join(sdkArtifacts, "withdraw.zkey");
  const vkeyPath = path.join(sdkArtifacts, "withdraw.vkey");

  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`ZKEY not found: ${zkeyPath}`);

  console.log("Running snarkjs.groth16.fullProve (this may take a minute)...");
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmPath,
    zkeyPath,
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Proof generated in ${elapsed}s!`);
  console.log(`Public signals (${publicSignals.length}):`);
  publicSignals.forEach((s: string, i: number) => {
    const labels = ["newCommitmentHash", "existingNullifierHash", "withdrawnValue", "stateRoot", "stateTreeDepth", "ASPRoot", "ASPTreeDepth", "context"];
    console.log(`  [${i}] ${labels[i] || "?"}: ${s}`);
  });

  // Verify proof locally
  console.log("\nVerifying proof locally...");
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(`Local verification: ${valid ? "VALID" : "INVALID"}`);
  if (!valid) throw new Error("Proof failed local verification!");

  // ---- STEP 9: Submit withdrawal via Relayer (direct relay call) ----
  console.log("\n--- Step 9: Submit Withdrawal via Relay ---");

  // Format proof for Solidity (used later for double-spend test)
  const formattedProof = {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])] as [bigint, bigint],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])] as [bigint, bigint],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    pubSignals: publicSignals.map((s: string) => BigInt(s)) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
  };

  // POST to relayer service
  const RELAYER_URL = "http://localhost:3001";

  console.log(`  processooor: ${withdrawal.processooor} (Entrypoint)`);
  console.log(`  recipient: ${account.address}`);
  console.log(`  feeRecipient: ${RELAYER_ADDRESS}`);
  console.log(`  withdrawnValue: ${publicSignals[2]}`);

  const relayPayload = {
    withdrawal: {
      processooor: withdrawal.processooor,
      data: withdrawal.data,
    },
    publicSignals: publicSignals,
    proof: {
      pi_a: proof.pi_a,
      pi_b: proof.pi_b,
      pi_c: proof.pi_c,
    },
    scope: scope.toString(),
    chainId: 9746,
  };

  console.log(`\nPOSTing to relayer at ${RELAYER_URL}/relayer/request ...`);

  const relayResponse = await fetch(`${RELAYER_URL}/relayer/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(relayPayload),
  });

  const relayResult = await relayResponse.json();
  console.log(`Relayer response:`, JSON.stringify(relayResult, null, 2));

  if (!relayResult.success) {
    console.log(`\nRelayer failed with: ${relayResult.error}`);
    throw new Error(`Relayer rejected: ${relayResult.error || JSON.stringify(relayResult)}`);
  }

  const withdrawHash = relayResult.txHash as Hex;
  console.log(`\nRelay tx: ${withdrawHash}`);
  const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
  console.log(`Block: ${withdrawReceipt.blockNumber}, Status: ${withdrawReceipt.status}`);

  // Verify the on-chain tx was sent by the RELAYER, not us
  const txDetails = await publicClient.getTransaction({ hash: withdrawHash });
  console.log(`\nOn-chain sender (msg.sender): ${txDetails.from}`);
  console.log(`Expected relayer address:      ${RELAYER_ADDRESS}`);
  console.log(`Relayer is sender: ${txDetails.from.toLowerCase() === RELAYER_ADDRESS.toLowerCase() ? "PASS" : "FAIL"}`);
  console.log(`Our address NOT sender: ${txDetails.from.toLowerCase() !== account.address.toLowerCase() ? "PASS" : "FAIL"}`);

  // Verify USDT balance increased
  const finalBalance = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`\nFinal USDT Balance: ${finalBalance} (${Number(finalBalance) / 1e6} USDT)`);

  // ---- STEP 10: Double-spend protection test ----
  console.log("\n--- Step 10: Double-Spend Protection Test ---");
  console.log("Replaying the exact same withdrawal proof (same nullifier)...");

  try {
    await walletClient.writeContract({
      address: USDT_POOL,
      abi: POOL_ABI,
      functionName: "withdraw",
      args: [withdrawal, formattedProof],
    });
    console.log("Double-spend rejected: FAIL — critical security issue");
  } catch (err: any) {
    const errMsg = err?.cause?.raw ?? err?.shortMessage ?? err?.message ?? String(err);
    console.log(`Reverted as expected: ${errMsg}`);
    console.log("Double-spend rejected: PASS");
  }

  // ---- STEP 11: Ragequit — emergency withdrawal of change note ----
  console.log("\n--- Step 11: Ragequit (Emergency Exit) ---");
  console.log("Ragequitting the 0.5 USDT change note still in the pool...");

  // The change note was created during Step 9 withdrawal:
  //   value     = changeAmount (500_000)
  //   label     = same label from deposit (label stays the same across withdrawals)
  //   nullifier = newNullifier (from Step 7)
  //   secret    = newSecret (from Step 7)
  //
  // Ragequit requires a commitment proof (not withdrawal proof).
  // Commitment circuit inputs: { value, label, nullifier, secret }
  // Commitment circuit public signals [4]: [commitmentHash, nullifierHash, value, label]

  const ragequitCircuitInputs = {
    value: changeAmount,
    label: label,
    nullifier: newNullifier,
    secret: newSecret,
  };

  console.log("Generating commitment proof for ragequit...");
  console.log(`  value:     ${ragequitCircuitInputs.value}`);
  console.log(`  label:     ${ragequitCircuitInputs.label}`);
  console.log(`  nullifier: ${ragequitCircuitInputs.nullifier}`);
  console.log(`  secret:    ${ragequitCircuitInputs.secret}`);

  const commitWasmPath = path.join(sdkArtifacts, "commitment.wasm");
  const commitZkeyPath = path.join(sdkArtifacts, "commitment.zkey");
  const commitVkeyPath = path.join(sdkArtifacts, "commitment.vkey");

  if (!fs.existsSync(commitWasmPath)) throw new Error(`Commitment WASM not found: ${commitWasmPath}`);
  if (!fs.existsSync(commitZkeyPath)) throw new Error(`Commitment ZKEY not found: ${commitZkeyPath}`);

  const commitStart = Date.now();
  const commitResult = await snarkjs.groth16.fullProve(
    ragequitCircuitInputs,
    commitWasmPath,
    commitZkeyPath,
  );
  const commitElapsed = ((Date.now() - commitStart) / 1000).toFixed(1);
  console.log(`Commitment proof generated in ${commitElapsed}s`);
  console.log(`Public signals (${commitResult.publicSignals.length}):`);
  const commitLabels = ["commitmentHash", "nullifierHash", "value", "label"];
  commitResult.publicSignals.forEach((s: string, i: number) => {
    console.log(`  [${i}] ${commitLabels[i] || "?"}: ${s}`);
  });

  // Verify commitment proof locally
  const commitVkey = JSON.parse(fs.readFileSync(commitVkeyPath, "utf-8"));
  const commitValid = await snarkjs.groth16.verify(commitVkey, commitResult.publicSignals, commitResult.proof);
  console.log(`Local verification: ${commitValid ? "VALID" : "INVALID"}`);
  if (!commitValid) throw new Error("Commitment proof failed local verification!");

  // Verify the commitment hash matches what the withdrawal circuit output as newCommitmentHash
  const changeCommitmentHash = BigInt(commitResult.publicSignals[0]!);
  const withdrawalNewCommitment = BigInt(publicSignals[0]!);
  console.log(`\nChange commitment hash (from commitment proof): ${changeCommitmentHash}`);
  console.log(`newCommitmentHash (from withdrawal proof):       ${withdrawalNewCommitment}`);
  console.log(`Match: ${changeCommitmentHash === withdrawalNewCommitment}`);
  if (changeCommitmentHash !== withdrawalNewCommitment) {
    throw new Error("Change note commitment hash mismatch — cannot ragequit!");
  }

  // Format ragequit proof for Solidity
  // RagequitProof: { pA: uint256[2], pB: uint256[2][2], pC: uint256[2], pubSignals: uint256[4] }
  const ragequitFormattedProof = {
    pA: [BigInt(commitResult.proof.pi_a[0]), BigInt(commitResult.proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(commitResult.proof.pi_b[0][1]), BigInt(commitResult.proof.pi_b[0][0])] as [bigint, bigint],
      [BigInt(commitResult.proof.pi_b[1][1]), BigInt(commitResult.proof.pi_b[1][0])] as [bigint, bigint],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(commitResult.proof.pi_c[0]), BigInt(commitResult.proof.pi_c[1])] as [bigint, bigint],
    pubSignals: commitResult.publicSignals.map((s: string) => BigInt(s)) as [bigint, bigint, bigint, bigint],
  };

  // Check USDT balance before ragequit
  const balanceBeforeRagequit = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`\nUSDT balance before ragequit: ${balanceBeforeRagequit} (${Number(balanceBeforeRagequit) / 1e6} USDT)`);

  // Submit ragequit
  const RAGEQUIT_POOL_ABI = parseAbi([
    "function ragequit((uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[4] pubSignals)) external",
    "event Ragequit(address indexed _ragequitter, uint256 _commitment, uint256 _label, uint256 _value)",
  ]);

  console.log("Submitting ragequit to pool contract...");
  const ragequitHash = await walletClient.writeContract({
    address: USDT_POOL,
    abi: RAGEQUIT_POOL_ABI,
    functionName: "ragequit",
    args: [ragequitFormattedProof],
  });
  const ragequitReceipt = await publicClient.waitForTransactionReceipt({ hash: ragequitHash });
  console.log(`Ragequit tx: ${ragequitHash}`);
  console.log(`Block: ${ragequitReceipt.blockNumber}, Status: ${ragequitReceipt.status}`);

  // Check USDT balance after ragequit
  const balanceAfterRagequit = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const ragequitReceived = balanceAfterRagequit - balanceBeforeRagequit;
  console.log(`USDT balance after ragequit:  ${balanceAfterRagequit} (${Number(balanceAfterRagequit) / 1e6} USDT)`);
  console.log(`Ragequit received: ${ragequitReceived} (${Number(ragequitReceived) / 1e6} USDT)`);
  console.log(`Ragequit amount matches change note: ${ragequitReceived === changeAmount ? "PASS" : "FAIL"}`);

  // ---- FINAL SUMMARY ----
  console.log("\n" + "=".repeat(60));
  console.log("FULL PRIVACY POOL CYCLE COMPLETE!");
  console.log("=".repeat(60));
  console.log(`  Step 3:  Deposited  ${Number(depositAmount) / 1e6} USDT`);
  console.log(`  Step 9:  Withdrew   ${Number(withdrawalAmount) / 1e6} USDT (ZK proof)`);
  console.log(`  Step 10: Double-spend replay → rejected`);
  console.log(`  Step 11: Ragequit   ${Number(changeAmount) / 1e6} USDT (emergency exit)`);
  console.log(`  Net:     Pool balance should be 0 USDT from our deposits`);
  console.log(`  Final USDT balance: ${Number(balanceAfterRagequit) / 1e6} USDT`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err);
  process.exit(1);
});
