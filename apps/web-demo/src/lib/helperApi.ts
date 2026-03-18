type JsonRecord = Record<string, unknown>;

async function readJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  return JSON.parse(text) as JsonRecord;
}

async function requestJson<T extends JsonRecord>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const body = (await readJson(response)) as T;

  if (!response.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return body;
}

export async function pingService(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/ping`);
  if (!response.ok) {
    return false;
  }

  const text = await response.text();
  return text.trim() === "pong";
}

export async function fundNative(
  baseUrl: string,
  address: string,
  amount: string,
): Promise<{ txHash: string }> {
  return requestJson<{ txHash: string }>(`${baseUrl}/fund-native`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, amount }),
  });
}

export async function mintUsdt(
  baseUrl: string,
  address: string,
  amount: string,
): Promise<{ txHash: string }> {
  return requestJson<{ txHash: string }>(`${baseUrl}/mint-usdt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, amount }),
  });
}

export async function publishAspRoot(
  baseUrl: string,
  root: bigint,
  cid: string,
): Promise<{ txHash: string }> {
  return requestJson<{ txHash: string }>(`${baseUrl}/publish-root`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: root.toString(), cid }),
  });
}
