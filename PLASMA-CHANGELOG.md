# Plasma Network Fork — Changelog

> Fork of [0xbow-io/privacy-pools-core](https://github.com/0xbow-io/privacy-pools-core) adapted for **Plasma Network (chain ID 9746)**.
> All changes are on the `main` branch on top of upstream `v1.1.1`.

## Deployed Contracts (Plasma Testnet)

| Contract | Address |
|----------|---------|
| Entrypoint (Proxy) | `0x40a16921be84b19675d26ef2215af30f7534eefb` |
| XPL Pool (PrivacyPoolSimple) | `0xdb4e84c2fe249c74aedf7d61f1fd9e41277ef904` |
| USDT Pool (PrivacyPoolComplex) | `0x25f1fd54f5f813b282ed719c603cfaca8f2a48f6` |
| USDT v2 Pool (PrivacyPoolComplex) | `0x04ef9B49a01A66Ac05520d906BF5345911d3b626` |
| WithdrawalVerifier | `0x03a7ad175889b694b5005f8835c6d8a6315a399c` |
| RagequitVerifier | `0x999a02Ff05448728160B6AD674C6785065612118` |
| USDT Token | `0x5e8135210b6C974F370e86139Ed22Af932a4d022` |
| CreateX Factory | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` |

---

## Changes from Upstream

### Commit `b7e3a82` — Relayer: skip Uniswap fee quoting when both fees are zero

**Problem:** The relayer crashes when processing native-asset (XPL) withdrawals with zero relay fee because `quoteFeeBPSNative()` unconditionally calls Uniswap's `quoteExactInputSingle`, which fails when there's no Uniswap deployment on Plasma.

**Files changed:**
- `packages/relayer/src/services/privacyPoolRelayer.service.ts`

**What changed:**
- Added early-return in `handleRequest()` that skips Uniswap quoting when `relayFeeBPS === 0n` and the fee receiver is the signer (i.e., no fee swap needed)
- Added structured error logging (`console.error("[handleRequest] Raw error:", e)`) for debugging relay failures
- Improved error messages in catch block to include root cause details

**Why:** Plasma Network doesn't have Uniswap V3 deployed. For zero-fee withdrawals (the typical case on testnet), the Uniswap call is unnecessary and causes a hard failure. This change makes the zero-fee path work without requiring a DEX.

---

### Commit `1cca1a7` — Fix 6 audit findings (P1–P3) across relayer, SDK, and contracts

#### P1: Quote handler input validation + division-by-zero guard

**Files changed:**
- `packages/relayer/src/handlers/relayer/quote.ts`
- `packages/relayer/src/services/quote.service.ts`

**What changed (quote.ts):**
- Added input validation before processing: `chainId` must be finite and positive, `amount` must parse to a positive `BigInt`, `asset` must be a valid checksummed address
- Invalid inputs now return 4xx (`QuoterError.assetNotSupported`) instead of causing unhandled 500 errors

**What changed (quote.service.ts):**
- Added zero-guard in `netFeeBPSNative()`: throws explicitly if `balance === 0n` or `nativeQuote.num === 0n` instead of producing a division-by-zero

**Why:** A malicious or malformed quote request with `amount=0` or `amount="not_a_number"` would crash the relayer process. The handler now validates all inputs at the boundary, and the service has defense-in-depth guards.

#### P2: SDK `getStateRoot` reads from wrong contract address

**Files changed:**
- `packages/sdk/src/core/contracts.service.ts` (line ~258)

**What changed:**
```typescript
// Before (WRONG): reads latestRoot from the pool address using Entrypoint ABI
address: privacyPoolAddress,

// After (CORRECT): reads latestRoot from the entrypoint address
address: this.entrypointAddress,
```

**Why:** `latestRoot` is a function on the Entrypoint contract, not on the pool. Reading from the pool address would return zero or revert, causing state sync failures in the SDK. This is a correctness bug — the function signature happened to not revert because the pool has a fallback, but it returned garbage data.

#### P2: SQLite initialization swallows errors silently

**Files changed:**
- `packages/relayer/src/providers/sqlite.provider.ts`

**What changed:**
```typescript
// Before: catch sets _initialized = true regardless of error
try { ... } catch (error) { console.error(error); }
this._initialized = true;  // Always runs!

// After: _initialized only set on success, errors re-thrown
try {
  ...
  this._initialized = true;  // Only on success
} catch (error) {
  console.error("FATAL: sqlite initialization failed:", error);
  throw error;  // Propagate to caller
}
```

**Why:** If the database file is corrupt or the filesystem is read-only, the old code would silently mark the provider as initialized. All subsequent writes would fail with confusing errors far from the root cause. Now it fails fast.

#### P2: Test hardcoded private key + test quality

**Files changed:**
- `packages/relayer/test/unit/privacyPoolRelayer.service.spec.ts`
- `packages/relayer/test/index.spec.ts`

**What changed (privacyPoolRelayer.service.spec.ts):**
- **Removed hardcoded private key** from test mock — now uses `process.env.TEST_SIGNER_KEY || \`0x${"ab".repeat(32)}\``
- **Complete rewrite**: The original tests mocked `PrivacyPoolRelayer` itself (the service under test!) via `vi.mock("../../src/services/privacyPoolRelayer.service.js")`, meaning they tested mock behavior, not the actual service logic
- New tests exercise the real `PrivacyPoolRelayer.handleRequest()` with only external dependencies mocked (config, providers, utils)
- Tests cover: processooor mismatch, fee recipient mismatch, withdrawn value too small, context mismatch, success path, invalid proof rejection

**What changed (index.spec.ts):**
- Added provider and service mocks so module-level instantiation in `services/index.ts` doesn't crash during import
- Replaced `it.skip("dummy")` with real export existence checks

**Why:** Tests that mock the system under test provide zero confidence. The rewritten tests catch real regressions (e.g., the context calculation bug would have been caught). The hardcoded key, while not a real secret, sets a bad pattern.

#### P3: Test server binds to 0.0.0.0 on fixed port

**Files changed:**
- `packages/sdk/test/unit/serve-artifacts.ts`
- `packages/sdk/test/unit/circuits.browser.spec.ts`

**What changed:**
- Server binds to `127.0.0.1` instead of `0.0.0.0` (loopback only, not all interfaces)
- Uses port `0` (OS-assigned ephemeral) instead of hardcoded `8888` to avoid port conflicts in CI
- Exports `testServerUrl` dynamically and sets `process.env.TEST_ARTIFACT_SERVER_URL`
- Browser test reads URL from env var with fallback

**Why:** Binding to `0.0.0.0` exposes the test server on all network interfaces. Fixed ports cause flaky CI when multiple test runs execute concurrently.

#### P3: Fuzz test precompile exclusion range too narrow

**Files changed:**
- `packages/contracts/test/unit/implementations/PrivacyPoolSimple.t.sol` (line ~178)

**What changed:**
```solidity
// Before: only excludes 0x01–0x0a
vm.assume(_recipient > address(10));

// After: excludes full precompile range 0x01–0xff
vm.assume(_recipient > address(0xff));
```

**Why:** EVM precompiles exist at addresses `0x01`–`0x09` on Ethereum, but other chains (including Plasma with BN254 precompiles) may use addresses up to `0xff`. Using `vm.etch` on these addresses in Foundry can collide with precompiles, causing spurious test failures depending on the chain's precompile set.

---

## E2E Test Scripts (not committed to main)

The following test scripts were used for Plasma Network validation and are available in the working directory:

| Script | Purpose |
|--------|---------|
| `plasma-pool-test.ts` | Full deposit → withdraw cycle for XPL pool |
| `plasma-concurrent-test.ts` | Concurrent deposits from multiple users |
| `plasma-relayer-e2e-test.ts` | HTTP relay request end-to-end |
| `plasma-multi-deposit-test.ts` | Multiple deposits → single withdrawal |
| `plasma-p2p-privacy-test.ts` | P2P private transfer (Alice → Bob) |
| `plasma-test-helpers.ts` | Shared test infrastructure |
