import { Circomkit } from "circomkit";
import { poseidon } from "../../../../node_modules/maci-crypto/build/ts/hashing.js";

export interface Commitment {
  value: bigint;
  label: bigint;
  nullifier: bigint;
  secret: bigint;
}

export const circomkit = new Circomkit({
  verbose: false,
  protocol: "groth16",
  include: ["../../node_modules/circomlib/circuits", "../../node_modules/maci-circuits/circom"],
});

export function hashCommitment(input: Commitment): [bigint, bigint] {
  const precommitment = poseidon([BigInt(input.nullifier), BigInt(input.secret)]);
  const nullifierHash = poseidon([BigInt(input.nullifier)]);
  const commitmentHash = poseidon([BigInt(input.value), BigInt(input.label), precommitment]);
  return [commitmentHash, nullifierHash];
}

/**
 * Generates a cryptographically random bigint in the BN128 scalar field.
 * Uses crypto.randomBytes(32) reduced modulo the field order for full 254-bit coverage.
 */
export function randomBigInt(): bigint {
  const BN128_FIELD_ORDER = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
  const bytes = require("crypto").randomBytes(32);
  const hex = "0x" + bytes.toString("hex");
  return BigInt(hex) % BN128_FIELD_ORDER;
}

export function padSiblings(siblings: bigint[], targetDepth: number): bigint[] {
  const paddedSiblings = [...siblings];
  while (paddedSiblings.length < targetDepth) {
    paddedSiblings.push(BigInt(0));
  }
  return paddedSiblings;
}
