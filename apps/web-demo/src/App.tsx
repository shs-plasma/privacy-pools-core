import { useEffect, useMemo, useState } from "react";

import { bytesToHex } from "@noble/hashes/utils";
import {
  computeStealthMetaAddress,
  deriveStealthKeys,
  encodeMetaAddress,
  type StealthKeys,
} from "@stealth-sdk";
import {
  type Hash,
  type Secret,
  PrivacyPoolSDK,
  generateDepositSecrets,
  generateMasterKeys,
  getCommitment,
  hashPrecommitment,
} from "@privacy-sdk";
import { ERC20ABI } from "@privacy-sdk-src/abi/ERC20";
import { IEntrypointABI } from "@privacy-sdk-src/abi/IEntrypoint";
import { IPrivacyPoolABI } from "@privacy-sdk-src/abi/IPrivacyPool";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  encodePacked,
  formatUnits,
  http,
  keccak256,
  numberToHex,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { english, generateMnemonic } from "viem/accounts";

import {
  DEFAULT_HELPER_URL,
  DEFAULT_RELAYER_URL,
  DEPOSIT_EVENT,
  ENTRYPOINT_DEPOSIT_EVENT,
  FAKE_CID,
  PLASMA_CHAIN,
  PLASMA_CONTRACTS,
  SNARK_SCALAR_FIELD,
} from "./config/plasma";
import { buildRelayPayload, prepareRelayedWithdrawal } from "./lib/e2e";
import { pingService, fundNative, mintUsdt, publishAspRoot } from "./lib/helperApi";
import { DemoCircuits } from "./lib/circuits";
import { formatHex, stringifyWithBigInt } from "./lib/format";

type WalletState = {
  address: Address | null;
  chainId: number | null;
};

type ServiceState = {
  helperReachable: boolean | null;
  relayerReachable: boolean | null;
};

type DraftDeposit = {
  amount: bigint;
  index: bigint;
  scope: Hash;
  nullifier: Secret;
  secret: Secret;
  precommitment: Hash;
};

type DepositedNote = DraftDeposit & {
  commitment: bigint;
  label: bigint;
  txHash: Hex;
  blockNumber: bigint;
};

type ProofState = {
  verified: boolean;
  publicSignals: readonly string[];
  proof: unknown;
};

type RelayState = {
  verified: boolean;
  publishRootTx: string;
  relayTx: string;
  changeAmount: bigint;
  receivedAmount: bigint;
  withdrawalAmount: bigint;
  stateLeafCount: number;
  aspLabelCount: number;
  publicSignals: readonly string[];
  relayerResponse: unknown;
};

const publicClient = createPublicClient({
  chain: PLASMA_CHAIN,
  transport: http(PLASMA_CHAIN.rpcUrls.default.http[0]),
});

const sdk = new PrivacyPoolSDK(new DemoCircuits());

function getWalletClient() {
  if (!window.ethereum) {
    throw new Error("No injected wallet found. Install MetaMask or Rabby.");
  }

  return createWalletClient({
    chain: PLASMA_CHAIN,
    transport: custom(window.ethereum),
  });
}

function positiveBigInt(value: string): bigint {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Index cannot be empty.");
  }

  const parsed = BigInt(normalized);
  if (parsed < 0n) {
    throw new Error("Index cannot be negative.");
  }

  return parsed;
}

function serviceBadge(value: boolean | null) {
  if (value === true) {
    return "ok";
  }

  if (value === false) {
    return "warn";
  }

  return "idle";
}

export default function App() {
  const [wallet, setWallet] = useState<WalletState>({
    address: null,
    chainId: null,
  });
  const [walletError, setWalletError] = useState<string | null>(null);
  const [scope, setScope] = useState<Hash | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);

  const [helperUrl, setHelperUrl] = useState(DEFAULT_HELPER_URL);
  const [relayerUrl, setRelayerUrl] = useState(DEFAULT_RELAYER_URL);
  const [services, setServices] = useState<ServiceState>({
    helperReachable: null,
    relayerReachable: null,
  });
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupTxs, setSetupTxs] = useState<{ xpl?: string; usdt?: string }>({});

  const [privacyMnemonic, setPrivacyMnemonic] = useState("");
  const [depositAmount, setDepositAmount] = useState("1.0");
  const [depositIndex, setDepositIndex] = useState("0");
  const [depositTxHash, setDepositTxHash] = useState("");
  const [draftDeposit, setDraftDeposit] = useState<DraftDeposit | null>(null);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositResult, setDepositResult] = useState<DepositedNote | null>(null);

  const [stealthKeys, setStealthKeys] = useState<StealthKeys | null>(null);
  const [stealthError, setStealthError] = useState<string | null>(null);
  const [stealthBusy, setStealthBusy] = useState(false);

  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [proofState, setProofState] = useState<ProofState | null>(null);

  const [withdrawAmount, setWithdrawAmount] = useState("0.5");
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<string | null>(null);
  const [relayState, setRelayState] = useState<RelayState | null>(null);

  const plasmaReady = wallet.chainId === PLASMA_CHAIN.id;

  useEffect(() => {
    if (!privacyMnemonic) {
      setPrivacyMnemonic(generateMnemonic(english));
    }
  }, [privacyMnemonic]);

  useEffect(() => {
    async function loadScope() {
      try {
        const currentScope = await publicClient.readContract({
          address: PLASMA_CONTRACTS.usdtPool,
          abi: IPrivacyPoolABI,
          functionName: "SCOPE",
        });
        setScope(currentScope as Hash);
        setScopeError(null);
      } catch (error) {
        setScopeError(
          error instanceof Error ? error.message : "Failed to load pool scope.",
        );
      }
    }

    void loadScope();
  }, []);

  useEffect(() => {
    void checkServices();
  }, []);

  useEffect(() => {
    if (!window.ethereum?.on) {
      return;
    }

    const handleAccountsChanged = (accountsValue: unknown) => {
      if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
        setWallet((current) => ({ address: null, chainId: current.chainId }));
        return;
      }

      setWallet((current) => ({
        address: accountsValue[0] as Address,
        chainId: current.chainId,
      }));
    };

    const handleChainChanged = (chainValue: unknown) => {
      const parsed =
        typeof chainValue === "string" ? Number.parseInt(chainValue, 16) : null;
      setWallet((current) => ({
        address: current.address,
        chainId: parsed,
      }));
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  const metaAddressHex = useMemo(() => {
    if (!stealthKeys) {
      return null;
    }

    return `0x${bytesToHex(
      encodeMetaAddress(computeStealthMetaAddress(stealthKeys)),
    )}`;
  }, [stealthKeys]);

  async function checkServices() {
    try {
      setSetupBusy("Checking helper and relayer...");
      setSetupError(null);
      const [helperReachable, relayerReachable] = await Promise.all([
        pingService(helperUrl),
        pingService(relayerUrl),
      ]);
      setServices({ helperReachable, relayerReachable });
    } catch (error) {
      setSetupError(
        error instanceof Error ? error.message : "Failed to check local services.",
      );
      setServices({ helperReachable: false, relayerReachable: false });
    } finally {
      setSetupBusy(null);
    }
  }

  async function connectWallet() {
    try {
      setWalletError(null);
      const client = getWalletClient();
      await window.ethereum?.request({ method: "eth_requestAccounts" });
      const [address] = await client.getAddresses();
      const chainId = await client.getChainId();
      setWallet({ address, chainId });
    } catch (error) {
      setWalletError(
        error instanceof Error ? error.message : "Failed to connect wallet.",
      );
    }
  }

  async function switchToPlasma() {
    try {
      setWalletError(null);
      if (!window.ethereum) {
        throw new Error("No injected wallet found.");
      }

      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: numberToHex(PLASMA_CHAIN.id) }],
        });
      } catch (error) {
        const code =
          typeof error === "object" && error && "code" in error
            ? (error as { code?: number }).code
            : undefined;

        if (code !== 4902) {
          throw error;
        }

        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: numberToHex(PLASMA_CHAIN.id),
              chainName: PLASMA_CHAIN.name,
              nativeCurrency: PLASMA_CHAIN.nativeCurrency,
              rpcUrls: PLASMA_CHAIN.rpcUrls.default.http,
              blockExplorerUrls: [
                PLASMA_CHAIN.blockExplorers?.default.url ?? "",
              ],
            },
          ],
        });
      }

      const client = getWalletClient();
      const chainId = await client.getChainId();
      const [address] = await client.getAddresses();
      setWallet({ address: address ?? wallet.address, chainId });
    } catch (error) {
      setWalletError(
        error instanceof Error ? error.message : "Failed to switch chain.",
      );
    }
  }

  async function deriveStealthIdentity() {
    try {
      setStealthBusy(true);
      setStealthError(null);
      const account = wallet.address;
      if (!account) {
        throw new Error("Connect a wallet first.");
      }

      const client = getWalletClient();
      const keys = await deriveStealthKeys((message) =>
        client.signMessage({
          account,
          message,
        }),
      );
      setStealthKeys(keys);
    } catch (error) {
      setStealthError(
        error instanceof Error ? error.message : "Stealth derivation failed.",
      );
    } finally {
      setStealthBusy(false);
    }
  }

  async function requestDemoXpl() {
    try {
      if (!wallet.address) {
        throw new Error("Connect a wallet first.");
      }

      setSetupBusy("Funding demo XPL...");
      setSetupError(null);
      const result = await fundNative(
        helperUrl,
        wallet.address,
        parseEther("0.2").toString(),
      );
      setSetupTxs((current) => ({ ...current, xpl: result.txHash }));
    } catch (error) {
      setSetupError(
        error instanceof Error ? error.message : "Failed to fund demo XPL.",
      );
    } finally {
      setSetupBusy(null);
    }
  }

  async function requestDemoUsdt() {
    try {
      if (!wallet.address) {
        throw new Error("Connect a wallet first.");
      }

      setSetupBusy("Minting demo USDT...");
      setSetupError(null);
      const result = await mintUsdt(
        helperUrl,
        wallet.address,
        parseUnits("10", 6).toString(),
      );
      setSetupTxs((current) => ({ ...current, usdt: result.txHash }));
    } catch (error) {
      setSetupError(
        error instanceof Error ? error.message : "Failed to mint demo USDT.",
      );
    } finally {
      setSetupBusy(null);
    }
  }

  function prepareDeposit() {
    try {
      setDepositError(null);
      if (!scope) {
        throw new Error("Pool scope is still loading.");
      }

      const amount = parseUnits(depositAmount, 6);
      const index = positiveBigInt(depositIndex);
      const masterKeys = generateMasterKeys(privacyMnemonic.trim());
      const { nullifier, secret } = generateDepositSecrets(
        masterKeys,
        scope,
        index,
      );
      const precommitment = hashPrecommitment(nullifier, secret);

      setDraftDeposit({
        amount,
        index,
        scope,
        nullifier,
        secret,
        precommitment,
      });
      setDepositResult(null);
      setProofState(null);
      setProofError(null);
      setRelayState(null);
      setRelayError(null);
      setRelayStatus(null);
      setDepositTxHash("");
    } catch (error) {
      setDepositError(
        error instanceof Error ? error.message : "Could not prepare deposit.",
      );
    }
  }

  async function findDepositEvent(
    txHash: Hex,
    blockNumber: bigint,
    preparedDeposit: DraftDeposit,
    depositorAddress: Address,
  ) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

    const receiptDeposit = [...receipt.logs]
      .reverse()
      .map((log) => {
        try {
          const decoded = decodeEventLog({
            abi: [DEPOSIT_EVENT],
            data: log.data,
            topics: log.topics,
          });

          if (
            decoded.eventName !== "Deposited" ||
            log.address.toLowerCase() !== PLASMA_CONTRACTS.usdtPool.toLowerCase()
          ) {
            return null;
          }

          return decoded;
        } catch {
          return null;
        }
      })
      .find((decoded) => decoded !== null);

    if (receiptDeposit) {
      return receiptDeposit.args;
    }

    const blockLogs = await publicClient.getLogs({
      address: PLASMA_CONTRACTS.usdtPool,
      event: DEPOSIT_EVENT,
      fromBlock: blockNumber,
      toBlock: blockNumber,
    });

    const matched = [...blockLogs]
      .reverse()
      .find((log) =>
        log.args._precommitmentHash === preparedDeposit.precommitment,
      );

    if (matched) {
      return matched.args;
    }

    const entrypointDeposit = [...receipt.logs]
      .reverse()
      .map((log) => {
        try {
          const decoded = decodeEventLog({
            abi: [ENTRYPOINT_DEPOSIT_EVENT],
            data: log.data,
            topics: log.topics,
          });

          if (
            decoded.eventName !== "Deposited" ||
            log.address.toLowerCase() !== PLASMA_CONTRACTS.entrypoint.toLowerCase() ||
            decoded.args._pool?.toLowerCase() !== PLASMA_CONTRACTS.usdtPool.toLowerCase()
          ) {
            return null;
          }

          return decoded.args;
        } catch {
          return null;
        }
      })
      .find((decoded) => decoded !== null);

    if (!entrypointDeposit?._commitment) {
      return null;
    }

    const poolNonce = (await publicClient.readContract({
      address: PLASMA_CONTRACTS.usdtPool,
      abi: IPrivacyPoolABI,
      functionName: "nonce",
    })) as bigint;

    const recentNonceCount = 32n;
    const firstNonce =
      poolNonce > recentNonceCount ? poolNonce - recentNonceCount + 1n : 1n;

    for (let nonce = poolNonce; nonce >= firstNonce; nonce -= 1n) {
      const label =
        BigInt(
          keccak256(
            encodePacked(
              ["uint256", "uint256"],
              [preparedDeposit.scope, nonce],
            ),
          ),
        ) % SNARK_SCALAR_FIELD;

      const labelDepositor = (await publicClient.readContract({
        address: PLASMA_CONTRACTS.usdtPool,
        abi: IPrivacyPoolABI,
        functionName: "depositors",
        args: [label],
      })) as Address;

      if (labelDepositor.toLowerCase() !== depositorAddress.toLowerCase()) {
        if (nonce === firstNonce) {
          break;
        }
        continue;
      }

      const expectedCommitment = getCommitment(
        preparedDeposit.amount,
        label,
        preparedDeposit.nullifier,
        preparedDeposit.secret,
      );

      if (expectedCommitment.hash === entrypointDeposit._commitment) {
        return {
          _depositor: labelDepositor,
          _commitment: expectedCommitment.hash,
          _label: label,
          _value: entrypointDeposit._amount ?? preparedDeposit.amount,
          _precommitmentHash: preparedDeposit.precommitment,
        };
      }

      if (nonce === firstNonce) {
        break;
      }
    }

    return null;
  }

  async function submitDeposit() {
    try {
      setDepositBusy(true);
      setDepositError(null);
      setProofState(null);
      setProofError(null);
      setRelayState(null);
      setRelayError(null);
      setRelayStatus(null);

      if (!wallet.address) {
        throw new Error("Connect a wallet first.");
      }
      if (!draftDeposit) {
        throw new Error("Prepare a deposit note first.");
      }
      if (!plasmaReady) {
        throw new Error("Switch to Plasma Testnet before depositing.");
      }

      const client = getWalletClient();
      const usdtBalance = (await publicClient.readContract({
        address: PLASMA_CONTRACTS.usdt,
        abi: ERC20ABI,
        functionName: "balanceOf",
        args: [wallet.address],
      })) as bigint;

      if (usdtBalance < draftDeposit.amount) {
        throw new Error(
          `Insufficient USDT balance. Need ${formatUnits(draftDeposit.amount, 6)} USDT, have ${formatUnits(usdtBalance, 6)} USDT. Mint demo USDT first.`,
        );
      }

      const allowance = (await publicClient.readContract({
        address: PLASMA_CONTRACTS.usdt,
        abi: ERC20ABI,
        functionName: "allowance",
        args: [wallet.address, PLASMA_CONTRACTS.entrypoint],
      })) as bigint;

      if (allowance < draftDeposit.amount) {
        const approveHash = await client.writeContract({
          account: wallet.address,
          address: PLASMA_CONTRACTS.usdt,
          abi: ERC20ABI,
          functionName: "approve",
          args: [PLASMA_CONTRACTS.entrypoint, draftDeposit.amount],
          chain: PLASMA_CHAIN,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      const depositHash = await client.writeContract({
        account: wallet.address,
        address: PLASMA_CONTRACTS.entrypoint,
        abi: IEntrypointABI,
        functionName: "deposit",
        args: [
          PLASMA_CONTRACTS.usdt,
          draftDeposit.amount,
          draftDeposit.precommitment,
        ],
        chain: PLASMA_CHAIN,
      });
      setDepositTxHash(depositHash);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: depositHash,
      });

      if (receipt.status !== "success") {
        throw new Error(
          `Deposit transaction reverted on-chain: ${depositHash}. Check USDT balance and allowance before retrying.`,
        );
      }

      const ownDeposit = await findDepositEvent(
        depositHash,
        receipt.blockNumber,
        draftDeposit,
        wallet.address,
      );

      if (!ownDeposit) {
        throw new Error(
          "Deposit transaction confirmed, but no deposit event was found.",
        );
      }

      setDepositResult({
        ...draftDeposit,
        commitment: ownDeposit._commitment!,
        label: ownDeposit._label!,
        txHash: depositHash,
        blockNumber: receipt.blockNumber,
      });
    } catch (error) {
      setDepositError(
        error instanceof Error ? error.message : "Deposit submission failed.",
      );
    } finally {
      setDepositBusy(false);
    }
  }

  async function loadDepositByTxHash() {
    try {
      setDepositBusy(true);
      setDepositError(null);

      if (!draftDeposit) {
        throw new Error("Prepare the deposit note first with the same mnemonic and index.");
      }
      if (!wallet.address) {
        throw new Error("Connect the wallet that made the deposit first.");
      }
      if (!depositTxHash.trim()) {
        throw new Error("Enter the confirmed deposit transaction hash.");
      }

      const txHash = depositTxHash.trim() as Hex;
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      const ownDeposit = await findDepositEvent(
        txHash,
        receipt.blockNumber,
        draftDeposit,
        wallet.address,
      );

      if (!ownDeposit) {
        throw new Error("No matching deposit event was found for that transaction.");
      }

      setDepositResult({
        ...draftDeposit,
        commitment: ownDeposit._commitment!,
        label: ownDeposit._label!,
        txHash,
        blockNumber: receipt.blockNumber,
      });
    } catch (error) {
      setDepositError(
        error instanceof Error ? error.message : "Could not load deposit transaction.",
      );
    } finally {
      setDepositBusy(false);
    }
  }

  async function proveCommitment() {
    try {
      setProofBusy(true);
      setProofError(null);
      if (!depositResult) {
        throw new Error("Deposit first so the label and commitment are known.");
      }

      const proof = await sdk.proveCommitment(
        depositResult.amount,
        depositResult.label,
        depositResult.nullifier,
        depositResult.secret,
      );
      const verified = await sdk.verifyCommitment(proof);

      setProofState({
        verified,
        publicSignals: proof.publicSignals,
        proof: proof.proof,
      });
    } catch (error) {
      setProofError(
        error instanceof Error ? error.message : "Commitment proof failed.",
      );
    } finally {
      setProofBusy(false);
    }
  }

  async function withdrawViaRelayer() {
    try {
      setRelayBusy(true);
      setRelayError(null);
      setRelayState(null);

      if (!depositResult) {
        throw new Error("Deposit a note before attempting withdrawal.");
      }
      if (!wallet.address) {
        throw new Error("Connect a wallet first.");
      }
      if (!scope) {
        throw new Error("Pool scope is still loading.");
      }
      if (!services.helperReachable) {
        throw new Error("Helper service is not reachable.");
      }
      if (!services.relayerReachable) {
        throw new Error("Relayer service is not reachable.");
      }

      const withdrawalAmountBase = parseUnits(withdrawAmount, 6);
      const masterKeys = generateMasterKeys(privacyMnemonic.trim());

      const balanceBefore = (await publicClient.readContract({
        address: PLASMA_CONTRACTS.usdt,
        abi: ERC20ABI,
        functionName: "balanceOf",
        args: [wallet.address],
      })) as bigint;

      setRelayStatus("Scanning pool history and building trees...");
      const prepared = await prepareRelayedWithdrawal(
        publicClient,
        depositResult,
        masterKeys,
        wallet.address,
        withdrawalAmountBase,
      );

      setRelayStatus("Publishing ASP root through the local helper...");
      const publishResult = await publishAspRoot(
        helperUrl,
        prepared.withdrawalInput.aspRoot,
        FAKE_CID,
      );

      setRelayStatus("Generating the withdrawal proof in the browser...");
      const noteCommitment = getCommitment(
        depositResult.amount,
        depositResult.label,
        depositResult.nullifier,
        depositResult.secret,
      );
      const withdrawalProof = await sdk.proveWithdrawal(
        noteCommitment,
        prepared.withdrawalInput,
      );
      const verified = await sdk.verifyWithdrawal(withdrawalProof);
      if (!verified) {
        throw new Error("Withdrawal proof failed local verification.");
      }

      setRelayStatus("Submitting the payload to the relayer...");
      const relayPayload = buildRelayPayload(
        prepared.withdrawal,
        scope,
        withdrawalProof,
      );
      const relayResponse = await fetch(`${relayerUrl}/relayer/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(relayPayload),
      });
      const relayBody = (await relayResponse.json()) as Record<string, unknown>;

      const responseData =
        relayBody.data && typeof relayBody.data === "object"
          ? (relayBody.data as Record<string, unknown>)
          : relayBody;

      const success = responseData.success === true;
      const relayTx = responseData.txHash;

      if (!success || typeof relayTx !== "string") {
        throw new Error(
          typeof responseData.error === "string"
            ? responseData.error
            : "Relayer rejected the withdrawal request.",
        );
      }

      setRelayStatus("Waiting for the relayed withdrawal to confirm...");
      await publicClient.waitForTransactionReceipt({
        hash: relayTx as Hex,
      });

      const balanceAfter = (await publicClient.readContract({
        address: PLASMA_CONTRACTS.usdt,
        abi: ERC20ABI,
        functionName: "balanceOf",
        args: [wallet.address],
      })) as bigint;

      setRelayState({
        verified,
        publishRootTx: publishResult.txHash,
        relayTx,
        changeAmount: prepared.changeAmount,
        receivedAmount: balanceAfter - balanceBefore,
        withdrawalAmount: withdrawalAmountBase,
        stateLeafCount: prepared.stateLeafCount,
        aspLabelCount: prepared.aspLabelCount,
        publicSignals: withdrawalProof.publicSignals,
        relayerResponse: relayBody,
      });
      setRelayStatus("Withdrawal completed.");
    } catch (error) {
      setRelayError(
        error instanceof Error ? error.message : "End-to-end withdrawal failed.",
      );
      setRelayStatus(null);
    } finally {
      setRelayBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Plasma Privacy Demo</p>
          <h1>Testnet deposit, proving, and relayed withdrawal.</h1>
          <p className="lede">
            This version uses the same contracts, addresses, relayer config, and
            withdrawal shape already exercised by the repo’s Plasma tests. The
            browser handles note creation and proof generation; a local helper
            handles the privileged setup actions the tests rely on.
          </p>
        </div>
        <div className="hero-stats">
          <div className="metric">
            <span>Network</span>
            <strong>{PLASMA_CHAIN.name}</strong>
          </div>
          <div className="metric">
            <span>Pool</span>
            <strong>{formatHex(PLASMA_CONTRACTS.usdtPool)}</strong>
          </div>
          <div className="metric">
            <span>Entrypoint</span>
            <strong>{formatHex(PLASMA_CONTRACTS.entrypoint)}</strong>
          </div>
        </div>
      </section>

      <section className="grid">
        <article className="panel panel-wide">
          <div className="panel-head">
            <h2>Setup</h2>
            <span className={`badge ${serviceBadge(services.helperReachable)}`}>
              {services.helperReachable && services.relayerReachable
                ? "Ready"
                : "Local services"}
            </span>
          </div>
          <p className="muted">
            For the full tested flow, run the local helper and the existing
            relayer service. The helper owns the test-only updater key so the
            browser never needs it.
          </p>
          <div className="field-row">
            <label className="field">
              <span>Helper URL</span>
              <input
                value={helperUrl}
                onChange={(event) => setHelperUrl(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Relayer URL</span>
              <input
                value={relayerUrl}
                onChange={(event) => setRelayerUrl(event.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button onClick={checkServices} disabled={setupBusy !== null}>
              {setupBusy === "Checking helper and relayer..."
                ? "Checking..."
                : "Check Services"}
            </button>
            <button
              className="secondary"
              onClick={requestDemoXpl}
              disabled={setupBusy !== null || !wallet.address}
            >
              {setupBusy === "Funding demo XPL..." ? "Funding..." : "Seed 0.2 XPL"}
            </button>
            <button
              className="secondary"
              onClick={requestDemoUsdt}
              disabled={setupBusy !== null || !wallet.address}
            >
              {setupBusy === "Minting demo USDT..." ? "Minting..." : "Mint 10 USDT"}
            </button>
          </div>
          <dl className="data-list">
            <div>
              <dt>Helper</dt>
              <dd>{services.helperReachable === null ? "Unchecked" : services.helperReachable ? "Reachable" : "Offline"}</dd>
            </div>
            <div>
              <dt>Relayer</dt>
              <dd>{services.relayerReachable === null ? "Unchecked" : services.relayerReachable ? "Reachable" : "Offline"}</dd>
            </div>
            <div>
              <dt>XPL seed tx</dt>
              <dd>{setupTxs.xpl ? formatHex(setupTxs.xpl) : "Not sent"}</dd>
            </div>
            <div>
              <dt>USDT mint tx</dt>
              <dd>{setupTxs.usdt ? formatHex(setupTxs.usdt) : "Not sent"}</dd>
            </div>
          </dl>
          {setupError && <p className="error">{setupError}</p>}
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Wallet</h2>
            <span className={`badge ${plasmaReady ? "ok" : "warn"}`}>
              {plasmaReady ? "On Plasma" : "Needs switch"}
            </span>
          </div>
          <p className="muted">
            Use an injected EVM wallet for deposits, signatures, and receiving
            relayed withdrawals.
          </p>
          <div className="actions">
            <button onClick={connectWallet}>Connect Wallet</button>
            <button className="secondary" onClick={switchToPlasma}>
              Switch to Plasma
            </button>
          </div>
          <dl className="data-list">
            <div>
              <dt>Account</dt>
              <dd>{wallet.address ? formatHex(wallet.address) : "Not connected"}</dd>
            </div>
            <div>
              <dt>Chain ID</dt>
              <dd>{wallet.chainId ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{scope ? scope.toString() : "Loading"}</dd>
            </div>
          </dl>
          {(walletError || scopeError) && (
            <p className="error">{walletError ?? scopeError}</p>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Stealth Identity</h2>
            <span className={`badge ${stealthKeys ? "ok" : "idle"}`}>
              {stealthKeys ? "Derived" : "Pending"}
            </span>
          </div>
          <p className="muted">
            Signs the versioned stealth messages already defined in the testkit
            and produces the 66-byte meta-address used by the privacy layer.
          </p>
          <div className="actions">
            <button onClick={deriveStealthIdentity} disabled={stealthBusy}>
              {stealthBusy ? "Deriving..." : "Derive from Wallet"}
            </button>
          </div>
          <dl className="data-list">
            <div>
              <dt>Meta-address</dt>
              <dd>{metaAddressHex ? formatHex(metaAddressHex, 14, 12) : "Not derived"}</dd>
            </div>
            <div>
              <dt>Spending pubkey</dt>
              <dd>
                {stealthKeys
                  ? formatHex(`0x${bytesToHex(stealthKeys.spendingPubKey)}`, 14, 10)
                  : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Viewing pubkey</dt>
              <dd>
                {stealthKeys
                  ? formatHex(`0x${bytesToHex(stealthKeys.viewingPubKey)}`, 14, 10)
                  : "Unavailable"}
              </dd>
            </div>
          </dl>
          {stealthError && <p className="error">{stealthError}</p>}
        </article>

        <article className="panel panel-wide">
          <div className="panel-head">
            <h2>Deposit Note</h2>
            <span className={`badge ${depositResult ? "ok" : draftDeposit ? "idle" : "warn"}`}>
              {depositResult ? "Deposited" : draftDeposit ? "Prepared" : "Not ready"}
            </span>
          </div>
          <p className="muted">
            The app generates a private note seed automatically. You only need
            it if you want to restore the same note later.
          </p>
          <details className="details">
            <summary>Recovery seed (advanced)</summary>
            <p className="muted">
              This seed never leaves the browser. It deterministically derives
              the note secrets, so keeping it lets you recover the same deposit
              after a refresh or on another machine.
            </p>
            <label className="field">
              <span>Recovery seed</span>
              <textarea
                rows={3}
                value={privacyMnemonic}
                onChange={(event) => setPrivacyMnemonic(event.target.value)}
              />
            </label>
          </details>
          <div className="field-row">
            <label className="field">
              <span>Deposit amount (USDT)</span>
              <input
                value={depositAmount}
                onChange={(event) => setDepositAmount(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Deposit index</span>
              <input
                value={depositIndex}
                onChange={(event) => setDepositIndex(event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Existing deposit tx hash</span>
            <input
              placeholder="0x..."
              value={depositTxHash}
              onChange={(event) => setDepositTxHash(event.target.value)}
            />
          </label>
          <div className="actions">
            <button onClick={prepareDeposit}>Prepare Note</button>
            <button
              className="secondary"
              onClick={() => setPrivacyMnemonic(generateMnemonic(english))}
            >
              New Seed
            </button>
            <button onClick={submitDeposit} disabled={depositBusy || !draftDeposit}>
              {depositBusy ? "Submitting..." : "Approve + Deposit"}
            </button>
            <button
              className="secondary"
              onClick={loadDepositByTxHash}
              disabled={depositBusy || !draftDeposit || !depositTxHash.trim()}
            >
              {depositBusy ? "Loading..." : "Load Deposit Tx"}
            </button>
          </div>
          <dl className="data-list">
            <div>
              <dt>Prepared amount</dt>
              <dd>{draftDeposit ? `${formatUnits(draftDeposit.amount, 6)} USDT` : "Not prepared"}</dd>
            </div>
            <div>
              <dt>Precommitment</dt>
              <dd>{draftDeposit ? formatHex(`0x${draftDeposit.precommitment.toString(16)}`) : "Not prepared"}</dd>
            </div>
            <div>
              <dt>Nullifier</dt>
              <dd>{draftDeposit ? formatHex(`0x${draftDeposit.nullifier.toString(16)}`) : "Not prepared"}</dd>
            </div>
            <div>
              <dt>Secret</dt>
              <dd>{draftDeposit ? formatHex(`0x${draftDeposit.secret.toString(16)}`) : "Not prepared"}</dd>
            </div>
            <div>
              <dt>On-chain label</dt>
              <dd>{depositResult ? depositResult.label.toString() : "Available after deposit"}</dd>
            </div>
            <div>
              <dt>Commitment</dt>
              <dd>{depositResult ? formatHex(`0x${depositResult.commitment.toString(16)}`) : "Available after deposit"}</dd>
            </div>
            <div>
              <dt>Tx hash</dt>
              <dd>{depositResult ? formatHex(depositResult.txHash) : "No transaction yet"}</dd>
            </div>
            <div>
              <dt>Block</dt>
              <dd>{depositResult ? depositResult.blockNumber.toString() : "No transaction yet"}</dd>
            </div>
          </dl>
          {depositError && <p className="error">{depositError}</p>}
        </article>

        <article className="panel panel-wide">
          <div className="panel-head">
            <h2>Commitment Proof</h2>
            <span className={`badge ${proofState?.verified ? "ok" : "idle"}`}>
              {proofState ? (proofState.verified ? "Verified" : "Invalid") : "Not run"}
            </span>
          </div>
          <p className="muted">
            This is the quick browser check for the deposited note itself before
            you move into the relayed withdrawal path.
          </p>
          <div className="actions">
            <button onClick={proveCommitment} disabled={proofBusy || !depositResult}>
              {proofBusy ? "Proving..." : "Prove Commitment"}
            </button>
          </div>
          <dl className="data-list">
            <div>
              <dt>Verification result</dt>
              <dd>{proofState ? String(proofState.verified) : "Pending"}</dd>
            </div>
            <div>
              <dt>Public signals</dt>
              <dd>{proofState ? proofState.publicSignals.length : 0}</dd>
            </div>
          </dl>
          <details className="details">
            <summary>Commitment proof payload</summary>
            <pre>{proofState ? stringifyWithBigInt(proofState) : "Run proof first."}</pre>
          </details>
          {proofError && <p className="error">{proofError}</p>}
        </article>

        <article className="panel panel-wide">
          <div className="panel-head">
            <h2>End-to-End Withdrawal</h2>
            <span className={`badge ${relayState?.verified ? "ok" : "idle"}`}>
              {relayState ? "Relayed" : "Ready"}
            </span>
          </div>
          <p className="muted">
            This follows the tested flow: scan pool history, publish the ASP
            root with the helper, generate a withdrawal proof in-browser, then
            POST the payload to the local relayer.
          </p>
          <div className="field-row">
            <label className="field">
              <span>Withdrawal amount (USDT)</span>
              <input
                value={withdrawAmount}
                onChange={(event) => setWithdrawAmount(event.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button
              onClick={withdrawViaRelayer}
              disabled={relayBusy || !depositResult}
            >
              {relayBusy ? "Running E2E..." : "Publish Root + Prove + Relay"}
            </button>
          </div>
          <dl className="data-list">
            <div>
              <dt>Status</dt>
              <dd>{relayStatus ?? "Idle"}</dd>
            </div>
            <div>
              <dt>Requested withdrawal</dt>
              <dd>{withdrawAmount} USDT</dd>
            </div>
            <div>
              <dt>ASP root tx</dt>
              <dd>{relayState ? formatHex(relayState.publishRootTx) : "Not sent"}</dd>
            </div>
            <div>
              <dt>Relayed tx</dt>
              <dd>{relayState ? formatHex(relayState.relayTx) : "Not sent"}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{relayState ? `${formatUnits(relayState.receivedAmount, 6)} USDT` : "Pending"}</dd>
            </div>
            <div>
              <dt>Change note</dt>
              <dd>{relayState ? `${formatUnits(relayState.changeAmount, 6)} USDT` : "Pending"}</dd>
            </div>
            <div>
              <dt>State leaves scanned</dt>
              <dd>{relayState ? relayState.stateLeafCount : "Pending"}</dd>
            </div>
            <div>
              <dt>ASP labels scanned</dt>
              <dd>{relayState ? relayState.aspLabelCount : "Pending"}</dd>
            </div>
          </dl>
          <details className="details">
            <summary>Relayer response</summary>
            <pre>{relayState ? stringifyWithBigInt(relayState.relayerResponse) : "Run the end-to-end flow first."}</pre>
          </details>
          {relayError && <p className="error">{relayError}</p>}
        </article>
      </section>
    </main>
  );
}
