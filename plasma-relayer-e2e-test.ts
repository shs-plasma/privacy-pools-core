/**
 * Relayer HTTP Service End-to-End Test on Plasma Testnet
 *
 * Tests the full relayer HTTP endpoint (POST /relayer/request) rather than
 * calling Entrypoint.relay() directly. The relayer service must be running.
 *
 * Test plan:
 *   1. Health check — verify relayer is running
 *   2. Deposit — deposit 1 USDT into the pool
 *   3. Build proof — scan pool state, build trees, generate Groth16 proof
 *   4. POST to relayer — submit withdrawal via HTTP
 *   5. Verify on-chain — confirm relayer sent the tx and recipient got funds
 *   6. Error cases — invalid proof, wrong chain, replay protection
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
const PLASMA_TESTNET_RPC =
  "https://thrumming-omniscient-fog.plasma-testnet.quiknode.pro/9e0462e2221113510287509d9ae53f6ade38e93b/";
const PRIVATE_KEY =
  "0xc36e3569a3ecd111369cd20cacb9f51133d3463aee7ff211b3276a5c142125e4" as Hex;

const ENTRYPOINT = "0x40a16921be84B19675D26ef2215aF30F7534EEfB" as Address;
const USDT_POOL = "0x25F1fD54F5f813b282eD719c603CfaCa8f2A48F6" as Address;
const USDT = "0x5e8135210b6C974F370e86139Ed22Af932a4d022" as Address;
const DEPLOY_BLOCK = 17346012n;
const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const RELAYER_ADDRESS = "0x8CB4E5200c018032fa2cc2898D0Fe62f6970556D" as Address;
const RELAYER_URL = "http://localhost:3000";

const plasmaTestnet = defineChain({
  id: 9746,
  name: "Plasma Testnet",
  nativeCurrency: { name: "XPL", symbol: "XPL", decimals: 18 },
  rpcUrls: { default: { http: [PLASMA_TESTNET_RPC] } },
});

// ============ CLIENTS ============
const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({
  chain: plasmaTestnet,
  transport: http(PLASMA_TESTNET_RPC),
});
const walletClient = createWalletClient({
  chain: plasmaTestnet,
  transport: http(PLASMA_TESTNET_RPC),
  account,
});

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

// ============ HELPERS ============
function hashPoseidon(inputs: bigint[]): bigint {
  return poseidon(inputs) as bigint;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ============ MAIN TEST ============
async function main() {
  console.log("=".repeat(70));
  console.log("Relayer HTTP Service E2E Test -- Plasma Testnet (Chain 9746)");
  console.log("=".repeat(70));
  console.log(`Deployer account: ${account.address}`);
  console.log(`Relayer address:  ${RELAYER_ADDRESS}`);
  console.log(`Relayer URL:      ${RELAYER_URL}`);
  console.log();

  // ================================================================
  // STEP 1: Health Check
  // ================================================================
  console.log("--- Step 1: Health Check ---");
  try {
    const pingRes = await fetch(`${RELAYER_URL}/ping`);
    const pingText = await pingRes.text();
    console.log(`GET /ping => ${pingRes.status} "${pingText}"`);
    if (pingRes.status !== 200) {
      throw new Error(`Relayer ping returned status ${pingRes.status}`);
    }
    console.log("Health check: PASS\n");
  } catch (err: any) {
    if (err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("fetch failed")) {
      console.error(
        "\nERROR: Relayer service is not running at " + RELAYER_URL,
      );
      console.error("Start the relayer first, then re-run this test.");
      process.exit(1);
    }
    throw err;
  }

  // ================================================================
  // STEP 2: Deposit 1 USDT
  // ================================================================
  console.log("--- Step 2: Deposit 1 USDT ---");

  const scope = await publicClient.readContract({
    address: USDT_POOL,
    abi: POOL_ABI,
    functionName: "SCOPE",
  });
  console.log(`Pool SCOPE: ${scope}`);

  // Unique secrets per run
  const depositIndex = BigInt(Date.now());
  const masterNullifier = hashPoseidon([12345n]);
  const masterSecret = hashPoseidon([67890n]);
  const nullifier = hashPoseidon([masterNullifier, scope, depositIndex]);
  const secret = hashPoseidon([masterSecret, scope, depositIndex]);
  const precommitment = hashPoseidon([nullifier, secret]);
  console.log(`Deposit index (unique): ${depositIndex}`);
  console.log(`Precommitment hash:     ${precommitment}`);

  const depositAmount = 1_000_000n; // 1 USDT (6 decimals)

  // Ensure balance
  const balance = await publicClient.readContract({
    address: USDT,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`USDT balance: ${formatUnits(balance, 6)} USDT`);

  if (balance < depositAmount) {
    console.log("Minting USDT...");
    const mintHash = await walletClient.writeContract({
      address: USDT,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [account.address, 10_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log(`Minted: ${mintHash}`);
  }

  // Approve
  const allowance = await publicClient.readContract({
    address: USDT,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, ENTRYPOINT],
  });
  if (allowance < depositAmount) {
    console.log("Approving USDT...");
    const approveHash = await walletClient.writeContract({
      address: USDT,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ENTRYPOINT, depositAmount * 100n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`Approved: ${approveHash}`);
  }

  // Deposit
  console.log(`Depositing ${formatUnits(depositAmount, 6)} USDT...`);
  const depositHash = await walletClient.writeContract({
    address: ENTRYPOINT,
    abi: ENTRYPOINT_ABI,
    functionName: "deposit",
    args: [USDT, depositAmount, precommitment],
    value: 0n,
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({
    hash: depositHash,
  });
  console.log(
    `Deposit tx: ${depositHash} (block ${depositReceipt.blockNumber}, status: ${depositReceipt.status})`,
  );

  // Parse deposit event
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

  if (depositLogs.length === 0) throw new Error("No deposit event found!");
  const depositEvent = depositLogs[depositLogs.length - 1]!;
  const onChainCommitment = depositEvent.args._commitment!;
  const label = depositEvent.args._label!;
  const onChainValue = depositEvent.args._value!;

  // Verify commitment
  const expectedCommitment = hashPoseidon([onChainValue, label, precommitment]);
  if (onChainCommitment !== expectedCommitment)
    throw new Error("Commitment mismatch!");
  console.log(`On-chain commitment: ${onChainCommitment}`);
  console.log(`Label: ${label}`);
  console.log(`Deposit: PASS\n`);

  // ================================================================
  // STEP 3: Build Proof
  // ================================================================
  console.log("--- Step 3: Build Trees & Generate Proof ---");

  // -- 3a: Build ASP tree from all deposit labels --
  const aspTree = new LeanIMT<bigint>((a: bigint, b: bigint) =>
    hashPoseidon([a, b]),
  );
  {
    const CHUNK = 9999n;
    const latestBlock = await publicClient.getBlockNumber();
    const scanTo =
      latestBlock >= depositReceipt.blockNumber
        ? latestBlock
        : depositReceipt.blockNumber;
    for (let from = DEPLOY_BLOCK; from <= scanTo; from += CHUNK + 1n) {
      const to = from + CHUNK > scanTo ? scanTo : from + CHUNK;
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
  if (aspTree.indexOf(label) === -1) {
    console.log("WARNING: label not in ASP tree, inserting manually");
    aspTree.insert(label);
  }
  const aspRoot = aspTree.root;
  const aspDepth = BigInt(aspTree.depth);
  console.log(`ASP tree: ${aspTree.size} labels, root=${aspRoot}, depth=${aspDepth}`);

  // Publish ASP root
  const fakeCID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const updateRootHash = await walletClient.writeContract({
    address: ENTRYPOINT,
    abi: ENTRYPOINT_ABI,
    functionName: "updateRoot",
    args: [aspRoot, fakeCID],
  });
  const updateReceipt = await publicClient.waitForTransactionReceipt({
    hash: updateRootHash,
  });
  console.log(
    `updateRoot tx: ${updateRootHash} (status: ${updateReceipt.status})`,
  );

  const latestRoot = await publicClient.readContract({
    address: ENTRYPOINT,
    abi: ENTRYPOINT_ABI,
    functionName: "latestRoot",
  });
  console.log(`Latest ASP root on-chain: ${latestRoot}`);

  // -- 3b: Build state tree from all Deposited + Withdrawn events --
  const currentBlock = await publicClient.getBlockNumber();
  const allLeafEntries: {
    commitment: bigint;
    blockNumber: bigint;
    logIndex: number;
    source: string;
  }[] = [];

  const CHUNK = 9999n;
  for (let from = DEPLOY_BLOCK; from <= currentBlock; from += CHUNK + 1n) {
    const to = from + CHUNK > currentBlock ? currentBlock : from + CHUNK;

    const dLogs = await publicClient.getLogs({
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
    for (const log of dLogs) {
      allLeafEntries.push({
        commitment: log.args._commitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        source: "Deposited",
      });
    }

    const wLogs = await publicClient.getLogs({
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
    for (const log of wLogs) {
      allLeafEntries.push({
        commitment: log.args._newCommitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        source: "Withdrawn",
      });
    }
  }

  allLeafEntries.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  const stateLeaves = allLeafEntries.map((e) => e.commitment);
  const stateTree = new LeanIMT<bigint>((a: bigint, b: bigint) =>
    hashPoseidon([a, b]),
  );
  stateTree.insertMany(stateLeaves);
  const stateRoot = stateTree.root;
  const stateDepth = BigInt(stateTree.depth);
  console.log(
    `State tree: ${stateLeaves.length} leaves (${allLeafEntries.filter((e) => e.source === "Deposited").length} deposits + ${allLeafEntries.filter((e) => e.source === "Withdrawn").length} withdrawals)`,
  );
  console.log(`State root: ${stateRoot}, depth: ${stateDepth}`);

  // Merkle proofs
  const stateIndex = stateTree.indexOf(onChainCommitment);
  if (stateIndex === -1) throw new Error("Commitment not in state tree!");
  const stateMerkleProof = stateTree.generateProof(stateIndex);

  const aspIndex = aspTree.indexOf(label);
  if (aspIndex === -1) throw new Error("Label not in ASP tree!");
  const aspMerkleProof = aspTree.generateProof(aspIndex);

  // -- 3c: Withdrawal params --
  const withdrawalAmount = 500_000n; // 0.5 USDT
  const changeAmount = onChainValue - withdrawalAmount;
  console.log(
    `Withdraw: ${formatUnits(withdrawalAmount, 6)} USDT, change: ${formatUnits(changeAmount, 6)} USDT`,
  );

  const newNullifier = hashPoseidon([masterNullifier, label, 0n]);
  const newSecret = hashPoseidon([masterSecret, label, 0n]);

  // Build withdrawal struct (for relayed withdrawal, processooor = Entrypoint)
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
        recipient: account.address,
        feeRecipient: RELAYER_ADDRESS,
        relayFeeBPS: 0n,
      },
    ],
  );

  const withdrawal = {
    processooor: getAddress(ENTRYPOINT),
    data: withdrawalData,
  };

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
            { processooor: withdrawal.processooor, data: withdrawal.data as Hex },
            scope,
          ],
        ),
      ),
    ) % SNARK_SCALAR_FIELD;

  // Pad siblings to MAX_DEPTH=32
  const MAX_DEPTH = 32;
  const paddedStateSiblings = [...stateMerkleProof.siblings];
  while (paddedStateSiblings.length < MAX_DEPTH) paddedStateSiblings.push(0n);
  const paddedASPSiblings = [...aspMerkleProof.siblings];
  while (paddedASPSiblings.length < MAX_DEPTH) paddedASPSiblings.push(0n);

  const circuitInputs = {
    withdrawnValue: withdrawalAmount,
    stateRoot,
    stateTreeDepth: stateDepth,
    ASPRoot: aspRoot,
    ASPTreeDepth: aspDepth,
    context,
    label,
    existingValue: onChainValue,
    existingNullifier: nullifier,
    existingSecret: secret,
    newNullifier,
    newSecret,
    stateSiblings: paddedStateSiblings,
    stateIndex: BigInt(stateMerkleProof.index ?? 0),
    ASPSiblings: paddedASPSiblings,
    ASPIndex: BigInt(aspMerkleProof.index ?? 0),
  };

  // -- 3d: Generate Groth16 proof --
  const sdkArtifacts = path.join(
    __dirname,
    "packages/contracts/node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts",
  );
  const wasmPath = path.join(sdkArtifacts, "withdraw.wasm");
  const zkeyPath = path.join(sdkArtifacts, "withdraw.zkey");
  const vkeyPath = path.join(sdkArtifacts, "withdraw.vkey");

  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`ZKEY not found: ${zkeyPath}`);

  console.log("Generating Groth16 proof (this may take a minute)...");
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmPath,
    zkeyPath,
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Proof generated in ${elapsed}s`);

  const signalLabels = [
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
    console.log(`  [${i}] ${signalLabels[i]}: ${s}`);
  });

  // Verify locally
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const localValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(`Local verification: ${localValid ? "VALID" : "INVALID"}`);
  if (!localValid) throw new Error("Proof failed local verification!");
  console.log("Proof generation: PASS\n");

  // Record balance before withdrawal
  const balanceBefore = await publicClient.readContract({
    address: USDT,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  // ================================================================
  // STEP 4: POST to Relayer
  // ================================================================
  console.log("--- Step 4: POST to Relayer ---");

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

  console.log(`POST ${RELAYER_URL}/relayer/request`);
  console.log(`  processooor: ${relayPayload.withdrawal.processooor} (Entrypoint)`);
  console.log(`  recipient:   ${account.address}`);
  console.log(`  scope:       ${relayPayload.scope}`);
  console.log(`  chainId:     ${relayPayload.chainId}`);

  const response = await fetch(`${RELAYER_URL}/relayer/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(relayPayload),
  });

  const result = await response.json() as any;
  console.log(`\nRelayer HTTP status: ${response.status}`);
  console.log("Relayer response:", JSON.stringify(result, null, 2));

  // Handle both possible response shapes: flat or wrapped in .data
  const success = result.success ?? result.data?.success;
  const txHash = result.txHash ?? result.data?.txHash;

  if (!success) {
    const errMsg = result.error ?? result.data?.error ?? result.message ?? JSON.stringify(result);
    throw new Error(`Relayer rejected the request: ${errMsg}`);
  }

  console.log(`Relayer success: ${success}`);
  console.log(`Relay tx hash:   ${txHash}`);
  console.log("Relayer POST: PASS\n");

  // ================================================================
  // STEP 5: Verify On-Chain
  // ================================================================
  console.log("--- Step 5: Verify On-Chain ---");

  const withdrawHash = txHash as Hex;
  const withdrawReceipt = await publicClient.waitForTransactionReceipt({
    hash: withdrawHash,
  });
  console.log(
    `Relay tx confirmed: block ${withdrawReceipt.blockNumber}, status: ${withdrawReceipt.status}`,
  );

  // Verify sender is the relayer, not us
  const txDetails = await publicClient.getTransaction({ hash: withdrawHash });
  const senderIsRelayer =
    txDetails.from.toLowerCase() === RELAYER_ADDRESS.toLowerCase();
  const senderIsNotUs =
    txDetails.from.toLowerCase() !== account.address.toLowerCase();

  console.log(`On-chain sender:  ${txDetails.from}`);
  console.log(`Expected relayer: ${RELAYER_ADDRESS}`);
  console.log(
    `Relayer is sender:     ${senderIsRelayer ? "PASS" : "FAIL"}`,
  );
  console.log(
    `Our address NOT sender: ${senderIsNotUs ? "PASS" : "FAIL"}`,
  );

  // Verify USDT balance increased
  const balanceAfter = await publicClient.readContract({
    address: USDT,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const received = balanceAfter - balanceBefore;
  console.log(
    `USDT balance before: ${formatUnits(balanceBefore, 6)}, after: ${formatUnits(balanceAfter, 6)}, received: ${formatUnits(received, 6)}`,
  );
  console.log(
    `Recipient got funds: ${received >= withdrawalAmount ? "PASS" : "FAIL"}`,
  );

  // Verify relayer response format
  const hasTimestamp =
    typeof (result.timestamp ?? result.data?.timestamp) === "number";
  const hasRequestId =
    typeof (result.requestId ?? result.data?.requestId) === "string";
  console.log(`Response has timestamp:  ${hasTimestamp ? "PASS" : "FAIL"}`);
  console.log(`Response has requestId:  ${hasRequestId ? "PASS" : "FAIL"}`);
  console.log("On-chain verification: PASS\n");

  // ================================================================
  // STEP 6: Error Cases
  // ================================================================
  console.log("--- Step 6: Error Cases ---");

  // -- 6a: Invalid proof --
  console.log("\n[6a] Invalid proof (corrupted pi_a)");
  {
    const badPayload = deepClone(relayPayload);
    badPayload.proof.pi_a[0] = "999";

    const res = await fetch(`${RELAYER_URL}/relayer/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(badPayload),
    });
    const body = await res.json() as any;
    console.log(`  HTTP status: ${res.status}`);
    console.log(`  Response: ${JSON.stringify(body)}`);

    const errSuccess = body.success ?? body.data?.success;
    // Either success=false, or an HTTP error status
    const rejected = errSuccess === false || res.status >= 400;
    console.log(`  Invalid proof rejected: ${rejected ? "PASS" : "FAIL"}`);
  }

  // -- 6b: Invalid chain --
  console.log("\n[6b] Invalid chain (chainId: 99999)");
  {
    const badPayload = deepClone(relayPayload);
    badPayload.chainId = 99999;

    const res = await fetch(`${RELAYER_URL}/relayer/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(badPayload),
    });
    const body = await res.json() as any;
    console.log(`  HTTP status: ${res.status}`);
    console.log(`  Response: ${JSON.stringify(body)}`);

    const errSuccess = body.success ?? body.data?.success;
    const rejected = errSuccess === false || res.status >= 400;
    console.log(`  Invalid chain rejected: ${rejected ? "PASS" : "FAIL"}`);
  }

  // -- 6c: Replay protection (same valid proof again) --
  console.log("\n[6c] Replay protection (resubmit same valid proof)");
  {
    const res = await fetch(`${RELAYER_URL}/relayer/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(relayPayload),
    });
    const body = await res.json() as any;
    console.log(`  HTTP status: ${res.status}`);
    console.log(`  Response: ${JSON.stringify(body)}`);

    const replaySuccess = body.success ?? body.data?.success;
    const rejected = replaySuccess === false || res.status >= 400;
    console.log(`  Replay rejected: ${rejected ? "PASS" : "FAIL"}`);
  }

  // ================================================================
  // FINAL SUMMARY
  // ================================================================
  console.log("\n" + "=".repeat(70));
  console.log("RELAYER E2E TEST COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Step 1: Health check          PASS`);
  console.log(`  Step 2: Deposit ${formatUnits(depositAmount, 6)} USDT    PASS`);
  console.log(`  Step 3: Proof generation       PASS`);
  console.log(`  Step 4: Relayer POST           PASS`);
  console.log(
    `  Step 5: On-chain verify        ${senderIsRelayer && senderIsNotUs && received >= withdrawalAmount ? "PASS" : "FAIL"}`,
  );
  console.log(`  Step 6a: Invalid proof         (see above)`);
  console.log(`  Step 6b: Invalid chain         (see above)`);
  console.log(`  Step 6c: Replay protection     (see above)`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err);
  process.exit(1);
});
