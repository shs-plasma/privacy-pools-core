// Define constants first to avoid hoisting issues
/* eslint-disable @typescript-eslint/no-unused-vars */
const FEE_RECEIVER_ADDRESS = "0x1212121212121212121212121212121212121212";
const RECIPIENT = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
const ENTRYPOINT_ADDRESS = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
const CHAIN_ID = 31337;
const ASSET_ADDRESS = "0x1111111111111111111111111111111111111111";
const MIN_WITHDRAW_AMOUNT = 200n;
const CONTEXT_VALUE = "0000000000000000000000000000000000000000000000000000000000000000";

// Create mock public signals with the context value
const PUBLIC_SIGNALS = [
  "1",
  "2",
  "2000",
  "4",
  "5",
  "6",
  "7",
  CONTEXT_VALUE
];

// Mock data — withdrawal data encoding for (feeRecipient, recipient, relayFeeBPS)
const dataCorrect = "0x0000000000000000000000001212121212121212121212121212121212121212000000000000000000000000e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007d0";
const dataMismatchFeeRecipient = "0x0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007d0";
const dataMismatchFee = "0x0000000000000000000000001212121212121212121212121212121212121212000000000000000000000000e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fa0";
/* eslint-enable @typescript-eslint/no-unused-vars */

// Mock the config module first
vi.mock("../../src/config/index.js", () => {
  return {
    CONFIG: {
      defaults: {
        fee_receiver_address: "0x1212121212121212121212121212121212121212",
        entrypoint_address: "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
        signer_private_key: process.env.TEST_SIGNER_KEY || `0x${"ab".repeat(32)}`
      },
      chains: [
        {
          chain_id: 31337,
          chain_name: "localhost",
          rpc_url: "http://localhost:8545",
          supported_assets: [
            {
              asset_address: "0x1111111111111111111111111111111111111111",
              asset_name: "TEST",
              fee_bps: 1000n,
              min_withdraw_amount: 200n
            }
          ]
        }
      ],
      sqlite_db_path: ":memory:"
    },
    getEntrypointAddress: vi.fn().mockReturnValue("0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"),
    getFeeReceiverAddress: vi.fn().mockReturnValue("0x1212121212121212121212121212121212121212"),
    getSignerPrivateKey: vi.fn().mockReturnValue(`0x${"ab".repeat(32)}`),
    getAssetConfig: vi.fn().mockReturnValue({
      asset_address: "0x1111111111111111111111111111111111111111",
      asset_name: "TEST",
      fee_bps: 1000n,
      min_withdraw_amount: 200n
    }),
    getChainConfig: vi.fn().mockReturnValue({
      chain_id: 31337,
      chain_name: "localhost",
      rpc_url: "http://localhost:8545",
      supported_assets: [
        {
          asset_address: "0x1111111111111111111111111111111111111111",
          asset_name: "TEST",
          fee_bps: 1000n,
          min_withdraw_amount: 200n
        }
      ]
    })
  };
});

// Mock the utils module
vi.mock("../../src/utils.js", () => ({
  decodeWithdrawalData: vi.fn((data) => {
    if (data === dataCorrect) {
      return {
        recipient: "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
        feeRecipient: "0x1212121212121212121212121212121212121212",
        relayFeeBPS: 1000n
      };
    } else if (data === dataMismatchFeeRecipient) {
      return {
        recipient: "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
        feeRecipient: "0x2222222222222222222222222222222222222222",
        relayFeeBPS: 1000n
      };
    } else if (data === dataMismatchFee) {
      return {
        recipient: "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
        feeRecipient: "0x1212121212121212121212121212121212121212",
        relayFeeBPS: 4000n
      };
    } else {
      return {
        recipient: "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
        feeRecipient: "0x1212121212121212121212121212121212121212",
        relayFeeBPS: 1000n
      };
    }
  }),
  parseSignals: vi.fn((signals) => {
    return {
      newCommitmentHash: 0n,
      existingNullifierHash: 0n,
      withdrawnValue: BigInt(signals[2]),
      stateRoot: 0n,
      stateTreeDepth: 0n,
      ASPRoot: 0n,
      ASPTreeDepth: 0n,
      context: BigInt("0x" + signals[7])
    };
  }),
  isFeeReceiverSameAsSigner: vi.fn().mockReturnValue(false),
  isNative: vi.fn().mockReturnValue(false),
  isViemError: vi.fn().mockReturnValue(false),
}));

// Mock the providers/index.js module to provide mock DB and SDK
vi.mock("../../src/providers/index.js", () => {
  const mockSdkProvider = {
    initialized: true,
    calculateContext: vi.fn((_withdrawal, scope) => {
      // For context mismatch test
      if (scope === BigInt(0x5c0fe)) {
        return "0x2ccc7ebae3d6e0489846523cad0cef023986027fc089dc4ce57f9ed644c5f185";
      }
      // For all other tests, match the context in the public signals (0x0...0)
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }),
    scopeData: vi.fn().mockResolvedValue({
      assetAddress: "0x1111111111111111111111111111111111111111",
    }),
    verifyWithdrawal: vi.fn().mockResolvedValue(true),
    broadcastWithdrawal: vi.fn().mockResolvedValue({ hash: "0xTxHash123" }),
  };

  return {
    db: {
      initialized: true,
      createNewRequest: vi.fn(),
      updateBroadcastedRequest: vi.fn(),
      updateFailedRequest: vi.fn(),
      run: vi.fn()
    },
    SdkProvider: vi.fn(() => mockSdkProvider),
    web3Provider: {
      getGasPrice: vi.fn().mockResolvedValue(1000000000n),
      client: vi.fn().mockReturnValue({
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ gasUsed: 500000n, effectiveGasPrice: 1000000000n }),
      }),
    },
    uniswapProvider: {},
  };
});

// Mock services/index.js to avoid circular dependency issues with quoteService
vi.mock("../../src/services/index.js", () => ({
  quoteService: {
    extraGasTxCost: 320000n,
    quoteFeeBPSNative: vi.fn().mockResolvedValue({ feeBPS: 500n, gasPrice: 1000000000n, relayTxCost: 650000n, path: [] }),
  },
}));

// Now import modules — the real PrivacyPoolRelayer, not a mock
import { describe, expect, it, vi, beforeEach } from "vitest";
import { WithdrawalValidationError } from "../../src/exceptions/base.exception.js";
import { WithdrawalPayload } from "../../src/interfaces/relayer/request.js";
import { PrivacyPoolRelayer } from "../../src/services/privacyPoolRelayer.service.js";
import { Groth16Proof } from "snarkjs";

function makePayload(overrides: Partial<{
  processooor: string;
  data: string;
  publicSignals: string[];
  scope: bigint;
}>): WithdrawalPayload {
  return {
    withdrawal: {
      processooor: overrides.processooor ?? ENTRYPOINT_ADDRESS,
      data: overrides.data ?? dataCorrect,
    },
    proof: {
      pi_a: ["0", "0"],
      pi_b: [["0", "0"], ["0", "0"]],
      pi_c: ["0", "0"],
      publicSignals: overrides.publicSignals ?? [
        "0", "0", "2000", "0", "0", "0", "0",
        CONTEXT_VALUE,
      ],
      protocol: "groth16",
      curve: "bn128",
    } as Groth16Proof,
    scope: overrides.scope ?? BigInt(0),
  };
}

describe("PrivacyPoolRelayer", () => {
  let service: PrivacyPoolRelayer;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PrivacyPoolRelayer();
  });

  describe("handleRequest — validation", () => {
    it("rejects when processooor doesn't point to entrypoint", async () => {
      const payload = makePayload({
        processooor: "0x0000000000000000000000000000000000000000",
      });

      const result = await service.handleRequest(payload, CHAIN_ID);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Processooor mismatch");
    });

    it("rejects when fee recipient doesn't match", async () => {
      const payload = makePayload({ data: dataMismatchFeeRecipient });

      const result = await service.handleRequest(payload, CHAIN_ID);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Fee recipient mismatch");
    });

    it("rejects when withdrawn value is too small", async () => {
      const payload = makePayload({
        publicSignals: ["0", "0", "100", "0", "0", "0", "0", CONTEXT_VALUE],
      });

      const result = await service.handleRequest(payload, CHAIN_ID);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Withdrawn value too small");
    });

    it("rejects when context doesn't match", async () => {
      const payload = makePayload({ scope: BigInt(0x5c0fe) });

      const result = await service.handleRequest(payload, CHAIN_ID);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Context mismatch");
    });
  });

  describe("handleRequest — success path", () => {
    it("returns success and txHash when all checks pass", async () => {
      const payload = makePayload({});

      const result = await service.handleRequest(payload, CHAIN_ID);
      expect(result.success).toBe(true);
      expect(result.txHash).toBe("0xTxHash123");
      expect(result.requestId).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });
  });

  describe("handleRequest — proof verification", () => {
    it("rejects when proof is invalid", async () => {
      // Make the mock verifyWithdrawal return false
      const { SdkProvider } = await import("../../src/providers/index.js");
      const sdk = new SdkProvider() as any;
      sdk.verifyWithdrawal.mockResolvedValueOnce(false);

      const payload = makePayload({});
      const result = await service.handleRequest(payload, CHAIN_ID);
      expect(result.success).toBe(false);
      expect(result.error).toContain("INVALID_PROOF");
    });
  });
});
