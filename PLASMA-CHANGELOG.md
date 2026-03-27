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

### Commit (pending) — Fix 14 audit findings from 2026-03-23 security review

Full security audit remediation. 13 findings fixed in code, 1 skipped (Finding 1: test private keys in git history — local test keys only), 1 requires manual follow-up (Finding 11: GitHub Actions SHA pinning — needs authenticated `gh` access).

> **Circuit constraint changes:** Findings 8 and 9 modify `merkleTree.circom`. Trusted setup artifacts must be regenerated before deployment. Testnet with dev artifacts is unaffected.

#### F2 (HIGH): ZK nullifier leaked in SDK proof generation error details

**Files changed:**
- `packages/sdk/src/core/commitment.service.ts`

**What changed:**
```typescript
// Before: nullifier included in error details — leaks to Sentry/Datadog
throw ProofError.generationFailed({
  error: error instanceof Error ? error.message : "Unknown error",
  inputSignals: { value, label, nullifier },
});

// After: only non-sensitive circuit name in error details
throw ProofError.generationFailed({
  error: error instanceof Error ? error.message : "Unknown error",
  circuit: CircuitName.Commitment,
});
```

**Why:** The nullifier is a private ZK signal. If proof generation fails and the error reaches any error monitoring service, the nullifier links deposits to withdrawals — breaking the core privacy guarantee.

#### F3 (HIGH): CORS allowed_domains default is a single concatenated string

**Files changed:**
- `packages/relayer/src/config/schemas.ts`

**What changed:**
```typescript
// Before: one string with commas inside it — indexOf() never matches any origin
.default(["https://testnet.privacypools.com, https://prod-..., ..."])

// After: proper array — each domain is a separate element
.default([
  "https://testnet.privacypools.com",
  "https://prod-privacy-pool-ui.vercel.app",
  "https://staging-privacy-pool-ui.vercel.app",
  "https://dev-privacy-pool-ui.vercel.app",
  "http://localhost:3000",
])
```

**Why:** When `cors_allow_all` is set to `false` for production hardening, all legitimate frontends are blocked. Currently masked because `cors_allow_all` defaults to `true`.

#### F4 (HIGH): ERC20 deposit uses requested value instead of actual received amount

**Files changed:**
- `packages/contracts/src/contracts/Entrypoint.sol`

**What changed:**
```solidity
// Before: commitment created for requested _value (wrong for fee-on-transfer tokens)
_asset.safeTransferFrom(msg.sender, address(this), _value);
_commitment = _handleDeposit(_asset, _value, _precommitment);

// After: commitment created for actual received amount (delta)
uint256 _balanceBefore = _asset.balanceOf(address(this));
_asset.safeTransferFrom(msg.sender, address(this), _value);
uint256 _actualReceived = _asset.balanceOf(address(this)) - _balanceBefore;
_commitment = _handleDeposit(_asset, _actualReceived, _precommitment);
```

**Why:** For fee-on-transfer tokens, the pool records more value than it holds. Multiple deposits compound the deficit until later users can't withdraw. First-come-first-served race ensues.

#### F5 (HIGH): No nullifier deduplication in relayer — concurrent replays waste gas

**Files changed:**
- `packages/relayer/src/services/privacyPoolRelayer.service.ts`

**What changed:**
- Added `private pendingNullifiers: Set<string>` to the relayer class
- Before processing, `handleRequest()` extracts `existingNullifierHash` from proof public signals
- If the nullifier is already in-flight, the request is rejected immediately (no gas spent)
- Nullifier is released in a `finally` block regardless of success or failure

**Why:** An attacker can send the same valid withdrawal proof 10 times simultaneously. All 10 pass validation and proof verification, all 10 are broadcast, but only 1 succeeds on-chain. The relayer pays gas for 9 failed txs. Repeated exploitation drains the relayer's ETH balance.

#### F6 (MEDIUM): Circuit boundary test uses Goldilocks field modulus instead of BN128

**Files changed:**
- `packages/circuits/tests/commitment.test.ts`

**What changed:**
```typescript
// Before: wrong field
const P = BigInt("18446744073709551615"); // 2^64-1 (Goldilocks)

// After: correct field
const P = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617"); // BN128
```

**Why:** Tests provide false assurance about boundary behavior. A vulnerability near the BN128 field boundary would be undetectable.

#### F7 (MEDIUM): Circuit tests use Math.random() with only 53 bits of entropy

**Files changed:**
- `packages/circuits/tests/common/index.ts`

**What changed:**
```typescript
// Before: only 53 bits of randomness
return BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

// After: full 254-bit field coverage
const bytes = require("crypto").randomBytes(32);
const hex = "0x" + bytes.toString("hex");
return BigInt(hex) % BN128_FIELD_ORDER;
```

**Why:** Tests never exercise large field elements, Poseidon with large inputs, or values near the 2^128 range check boundary.

#### F8 (MEDIUM): LeanIMT zero-sibling ambiguity allows multiple valid Merkle proofs

**Files changed:**
- `packages/circuits/circuits/merkleTree.circom`

**What changed:**
- Added a `zeroSeen` accumulator signal after the main hash loop
- Once a zero sibling is encountered, all subsequent siblings must also be zero
- Enforced via OR-gate accumulator and equality constraint: `zeroSeen[i] * siblings[i] === 0`

**Why:** The same leaf could have multiple valid proofs with different zero-padding patterns. Currently mitigated by on-chain root validation, but non-unique proofs are a soundness concern if the protocol evolves.

#### F9 (MEDIUM): LessEqThan(6) depth check only supports maxDepth up to 63

**Files changed:**
- `packages/circuits/circuits/merkleTree.circom`

**What changed:**
```circom
// Before: 6-bit comparator, silent truncation for actualDepth > 63
component depthCheck = LessEqThan(6);

// After: 8-bit comparator, safe up to maxDepth=255
component depthCheck = LessEqThan(8);
```

**Why:** Currently safe at `maxDepth=32`, but would silently produce wrong results if tree depth increases beyond 63. Adds safety margin.

#### F10 (MEDIUM): SQLite init sets _initialized=true on failure — NO FIX NEEDED

**Files changed:** None

**Why:** Current code already has the correct pattern — `_initialized = true` is inside the `try` block and errors are re-thrown. This finding was addressed in the previous audit round (commit `1cca1a7`).

#### F11 (MEDIUM): Third-party GitHub Actions use mutable version tags — MANUAL FOLLOW-UP

**Files changed:** None (requires authenticated `gh` CLI)

**Action required:** Pin all third-party actions to full SHA hashes. Run:
```bash
gh api repos/OWNER/REPO/git/ref/tags/TAG --jq '.object.sha'
```
for each of: `foundry-rs/foundry-toolchain@v1`, `wagoid/commitlint-github-action@v5`, `amondnet/vercel-action@v25`, `hrishikesh-kadam/setup-lcov@v1`, `zgosalvez/github-actions-report-lcov@v4`, `google-github-actions/auth@v2`, `docker/*` actions, `azure/setup-helm@v4.1.0`, `thollander/actions-comment-pull-request@v2`.

#### F12 (MEDIUM): SDK console.error calls leak account addresses and transaction details

**Files changed:**
- `packages/sdk/src/core/contracts.service.ts`

**What changed:**
- Removed 8 `console.error` statements that logged `error`, `accountAddress`, `asset`, `amount`, `tokenAddress`, and `request` objects
- Affected methods: `depositERC20`, `depositETH`, `withdraw`, `relay`, `ragequit`, `approveERC20`, `getScopeData`, `executeTransaction`
- Errors are still thrown with messages — just no longer dumped to console with sensitive context

**Why:** In a privacy pool protocol, linking account addresses to specific pool operations undermines the core privacy guarantee. Browser extensions or error reporters could capture these logs.

#### F13 (MEDIUM): Relayer validation errors expose internal addresses and fee structure

**Files changed:**
- `packages/relayer/src/services/privacyPoolRelayer.service.ts`

**What changed:**
```typescript
// Before: leaks expected vs actual addresses in error messages
`Processooor mismatch: expected "${entrypointAddress}", got "${wp.withdrawal.processooor}".`
`Fee recipient mismatch: expected "${feeReceiverAddress}", got "${feeRecipient}".`

// After: generic messages, no internal addresses
`Processooor mismatch: the provided processooor address does not match the expected entrypoint.`
`Fee recipient does not match the expected fee receiver address.`
```

**Why:** An attacker can send intentionally malformed requests to harvest error responses and map relayer configuration — signer address, fee structure, expected values.

#### F14 (MEDIUM): Full withdrawal payloads stored persistently in SQLite

**Files changed:**
- `packages/relayer/src/providers/sqlite.provider.ts`

**What changed:**
```typescript
// Before: entire WithdrawalPayload (proof, recipient, amounts) serialized to DB
const strigifiedPayload = JSON.stringify(req, replacer);

// After: only operational minimum (scope)
const redactedPayload = JSON.stringify({
  scope: req.scope,
  // Omit: proof, withdrawal, feeCommitment — these enable deanonymization
}, replacer);
```

**Why:** If an attacker gains access to the SQLite file (server compromise, backup leak), they can extract all withdrawal requests with timestamps, recipient addresses, and amounts — enabling deanonymization analysis.

#### F15 (MEDIUM): relay() balance check measures Entrypoint, not pool

**Files changed:**
- `packages/contracts/src/contracts/Entrypoint.sol`

**What changed:**
- Added `_poolAssetBalance()` helper function that reads the balance of a specific pool address
- The `relay()` function now checks both:
  - Entrypoint balance didn't decrease (existing check, renamed for clarity)
  - Pool balance decreased by exactly `_withdrawnAmount` (new invariant)

**Why:** The original check only validates the Entrypoint wasn't drained. A malicious pool (registered by compromised owner) could manipulate this by stealing from the Entrypoint's accumulated fee balance while passing the check.

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
