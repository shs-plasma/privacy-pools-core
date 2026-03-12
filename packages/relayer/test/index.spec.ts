import { describe, it, expect, vi } from "vitest";

// Mock config to avoid config.json parsing at import time
vi.mock("../src/config/index.js", () => ({
  CONFIG: {
    defaults: {
      fee_receiver_address: "0x0000000000000000000000000000000000000001",
      entrypoint_address: "0x0000000000000000000000000000000000000002",
      signer_private_key: `0x${"ab".repeat(32)}`,
    },
    chains: [],
    sqlite_db_path: ":memory:",
  },
  getEntrypointAddress: vi.fn(),
  getFeeReceiverAddress: vi.fn(),
  getAssetConfig: vi.fn(),
  getChainConfig: vi.fn(),
  getSignerPrivateKey: vi.fn(),
}));

// Mock providers to avoid real connections during import
vi.mock("../src/providers/index.js", () => ({
  db: { initialized: false, init: vi.fn() },
  SdkProvider: vi.fn(),
  SqliteDatabase: vi.fn(),
  UniswapProvider: vi.fn(),
  web3Provider: { getGasPrice: vi.fn() },
  uniswapProvider: {},
  quoteProvider: {},
}));

// Mock services/index.js to avoid module-level instantiation side effects
vi.mock("../src/services/index.js", () => ({
  PrivacyPoolRelayer: vi.fn(),
  privacyPoolRelayer: {},
  quoteService: { extraGasTxCost: 0n },
}));

// Mock utils to avoid any real dependencies
vi.mock("../src/utils.js", () => ({
  decodeWithdrawalData: vi.fn(),
  parseSignals: vi.fn(),
  isFeeReceiverSameAsSigner: vi.fn(),
  isNative: vi.fn(),
  isViemError: vi.fn(),
}));

describe("relayer module exports", () => {
  it("exports PrivacyPoolRelayer class", async () => {
    const mod = await import("../src/services/privacyPoolRelayer.service.js");
    expect(mod.PrivacyPoolRelayer).toBeDefined();
    expect(typeof mod.PrivacyPoolRelayer).toBe("function");
  });

  it("exports QuoteService class", async () => {
    const mod = await import("../src/services/quote.service.js");
    expect(mod.QuoteService).toBeDefined();
    expect(typeof mod.QuoteService).toBe("function");
  });

  it("exports SqliteDatabase class", async () => {
    const mod = await import("../src/providers/sqlite.provider.js");
    expect(mod.SqliteDatabase).toBeDefined();
    expect(typeof mod.SqliteDatabase).toBe("function");
  });
});
