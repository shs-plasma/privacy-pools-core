import http from "node:http";

import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PORT = Number.parseInt(process.env.HELPER_PORT ?? "8787", 10);
const RPC_URL =
  process.env.PLASMA_RPC_URL ??
  "https://thrumming-omniscient-fog.plasma-testnet.quiknode.pro/9e0462e2221113510287509d9ae53f6ade38e93b/";
const DEPLOYER_KEY =
  process.env.DEMO_DEPLOYER_KEY ??
  "0xc36e3569a3ecd111369cd20cacb9f51133d3463aee7ff211b3276a5c142125e4";
const ENTRYPOINT = "0x40a16921be84B19675D26ef2215aF30F7534EEfB";
const USDT = "0x5e8135210b6C974F370e86139Ed22Af932a4d022";

const plasmaTestnet = {
  id: 9746,
  name: "Plasma Testnet",
  nativeCurrency: { name: "XPL", symbol: "XPL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const account = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({
  chain: plasmaTestnet,
  transport: viemHttp(RPC_URL),
});
const walletClient = createWalletClient({
  chain: plasmaTestnet,
  transport: viemHttp(RPC_URL),
  account,
});

const erc20Abi = parseAbi([
  "function mint(address, uint256) returns (bool)",
]);

const entrypointAbi = parseAbi([
  "function updateRoot(uint256 _root, string _ipfsCID) returns (uint256)",
]);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleMintUsdt(req, res) {
  const { address, amount } = await readBody(req);
  if (typeof address !== "string" || typeof amount !== "string") {
    sendJson(res, 400, { error: "Expected address and amount strings." });
    return;
  }

  const txHash = await walletClient.writeContract({
    account,
    address: USDT,
    abi: erc20Abi,
    functionName: "mint",
    args: [address, BigInt(amount)],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  sendJson(res, 200, { txHash });
}

async function handleFundNative(req, res) {
  const { address, amount } = await readBody(req);
  if (typeof address !== "string" || typeof amount !== "string") {
    sendJson(res, 400, { error: "Expected address and amount strings." });
    return;
  }

  const txHash = await walletClient.sendTransaction({
    account,
    to: address,
    value: BigInt(amount),
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  sendJson(res, 200, { txHash });
}

async function handlePublishRoot(req, res) {
  const { root, cid } = await readBody(req);
  if (typeof root !== "string" || typeof cid !== "string") {
    sendJson(res, 400, { error: "Expected root and cid strings." });
    return;
  }

  const txHash = await walletClient.writeContract({
    account,
    address: ENTRYPOINT,
    abi: entrypointAbi,
    functionName: "updateRoot",
    args: [BigInt(root), cid],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  sendJson(res, 200, { txHash });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && req.url === "/ping") {
      sendText(res, 200, "pong");
      return;
    }

    if (req.method === "POST" && req.url === "/mint-usdt") {
      await handleMintUsdt(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/fund-native") {
      await handleFundNative(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/publish-root") {
      await handlePublishRoot(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unknown helper error.",
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Helper listening on http://127.0.0.1:${PORT}`);
  console.log(`Updater account: ${account.address}`);
});
