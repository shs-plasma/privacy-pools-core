import { LeanIMT, type LeanIMTMerkleProof } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import {
  calculateContext,
  generateWithdrawalSecrets,
  getCommitment,
  type Hash,
  type MasterKeys,
  type Secret,
  type Withdrawal,
  type WithdrawalProofInput,
} from "@privacy-sdk";
import {
  encodeAbiParameters,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  DEPOSIT_EVENT,
  DEPLOY_BLOCK,
  PLASMA_CHAIN,
  PLASMA_CONTRACTS,
  RELAYER_ADDRESS,
  WITHDRAWN_EVENT,
} from "../config/plasma";

export interface DepositedNoteInput {
  amount: bigint;
  commitment: bigint;
  label: bigint;
  nullifier: Secret;
  secret: Secret;
  blockNumber: bigint;
  scope: Hash;
}

export interface PreparedRelayedWithdrawal {
  withdrawal: Withdrawal;
  withdrawalInput: WithdrawalProofInput;
  changeAmount: bigint;
  stateLeafCount: number;
  aspLabelCount: number;
}

export function hashPoseidon(inputs: bigint[]): bigint {
  return poseidon(inputs) as bigint;
}

function padMerkleProof(
  proof: LeanIMTMerkleProof<bigint>,
): LeanIMTMerkleProof<bigint> {
  const siblings = [...proof.siblings];
  while (siblings.length < 32) {
    siblings.push(0n);
  }

  return {
    ...proof,
    siblings,
  };
}

async function scanPoolState(
  publicClient: PublicClient,
  upToBlock: bigint,
): Promise<{ leaves: bigint[]; labels: bigint[] }> {
  const leaves: {
    commitment: bigint;
    blockNumber: bigint;
    logIndex: number;
  }[] = [];
  const labels: bigint[] = [];
  const chunk = 9_999n;

  for (let from = DEPLOY_BLOCK; from <= upToBlock; from += chunk + 1n) {
    const to = from + chunk > upToBlock ? upToBlock : from + chunk;

    const depositLogs = await publicClient.getLogs({
      address: PLASMA_CONTRACTS.usdtPool,
      event: DEPOSIT_EVENT,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of depositLogs) {
      leaves.push({
        commitment: log.args._commitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      });
      labels.push(log.args._label!);
    }

    const withdrawnLogs = await publicClient.getLogs({
      address: PLASMA_CONTRACTS.usdtPool,
      event: WITHDRAWN_EVENT,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of withdrawnLogs) {
      leaves.push({
        commitment: log.args._newCommitment!,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      });
    }
  }

  leaves.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }

    return left.logIndex - right.logIndex;
  });

  return {
    leaves: leaves.map((entry) => entry.commitment),
    labels,
  };
}

export async function prepareRelayedWithdrawal(
  publicClient: PublicClient,
  note: DepositedNoteInput,
  masterKeys: MasterKeys,
  recipient: Address,
  withdrawalAmount: bigint,
): Promise<PreparedRelayedWithdrawal> {
  const currentBlock = await publicClient.getBlockNumber();
  const scanTo = currentBlock >= note.blockNumber ? currentBlock : note.blockNumber;
  const { leaves, labels } = await scanPoolState(publicClient, scanTo);

  const aspTree = new LeanIMT<bigint>((left, right) =>
    hashPoseidon([left, right]),
  );
  for (const label of labels) {
    aspTree.insert(label);
  }
  if (aspTree.indexOf(note.label) === -1) {
    aspTree.insert(note.label);
  }

  const stateTree = new LeanIMT<bigint>((left, right) =>
    hashPoseidon([left, right]),
  );
  stateTree.insertMany(leaves);

  const stateIndex = stateTree.indexOf(note.commitment);
  if (stateIndex === -1) {
    throw new Error("Commitment not found in state tree.");
  }

  const aspIndex = aspTree.indexOf(note.label);
  if (aspIndex === -1) {
    throw new Error("Label not found in ASP tree.");
  }

  const changeAmount = note.amount - withdrawalAmount;
  if (changeAmount < 0n) {
    throw new Error("Withdrawal amount exceeds note value.");
  }

  const { nullifier: newNullifier, secret: newSecret } =
    generateWithdrawalSecrets(masterKeys, note.label as Hash, 0n);

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
        recipient,
        feeRecipient: RELAYER_ADDRESS,
        relayFeeBPS: 0n,
      },
    ],
  );

  const withdrawal = {
    processooor: getAddress(PLASMA_CONTRACTS.entrypoint),
    data: withdrawalData as Hex,
  } satisfies Withdrawal;

  const withdrawalInput = {
    context: BigInt(calculateContext(withdrawal, note.scope)),
    withdrawalAmount,
    stateMerkleProof: padMerkleProof(stateTree.generateProof(stateIndex)),
    aspMerkleProof: padMerkleProof(aspTree.generateProof(aspIndex)),
    stateRoot: stateTree.root as Hash,
    stateTreeDepth: BigInt(stateTree.depth),
    aspRoot: aspTree.root as Hash,
    aspTreeDepth: BigInt(aspTree.depth),
    newNullifier,
    newSecret,
  } satisfies WithdrawalProofInput;

  return {
    withdrawal,
    withdrawalInput,
    changeAmount,
    stateLeafCount: leaves.length,
    aspLabelCount: labels.length,
  };
}

export function buildRelayPayload(
  withdrawal: Withdrawal,
  scope: bigint,
  proof: {
    proof: {
      pi_a: readonly unknown[];
      pi_b: readonly unknown[];
      pi_c: readonly unknown[];
    };
    publicSignals: readonly string[];
  },
) {
  return {
    withdrawal,
    publicSignals: proof.publicSignals,
    proof: {
      pi_a: proof.proof.pi_a,
      pi_b: proof.proof.pi_b,
      pi_c: proof.proof.pi_c,
    },
    scope: scope.toString(),
    chainId: PLASMA_CHAIN.id,
  };
}
