import { CircuitName } from "@privacy-sdk-src/interfaces/circuits.interface";

const artifacts = {
  [CircuitName.Commitment]: {
    wasm: "commitment.wasm",
    zkey: "commitment.zkey",
    vkey: "commitment.vkey",
  },
  [CircuitName.Withdraw]: {
    wasm: "withdraw.wasm",
    zkey: "withdraw.zkey",
    vkey: "withdraw.vkey",
  },
} as const;

type ArtifactKind = "wasm" | "zkey" | "vkey";
type CacheKey = `${CircuitName}:${ArtifactKind}`;

export class DemoCircuits {
  private cache = new Map<CacheKey, Promise<Uint8Array>>();

  constructor(private readonly basePath = "/artifacts") {}

  async getWasm(name: CircuitName): Promise<Uint8Array> {
    return this.getArtifact(name, "wasm");
  }

  async getProvingKey(name: CircuitName): Promise<Uint8Array> {
    return this.getArtifact(name, "zkey");
  }

  async getVerificationKey(name: CircuitName): Promise<Uint8Array> {
    return this.getArtifact(name, "vkey");
  }

  private getArtifact(
    name: CircuitName,
    kind: ArtifactKind,
  ): Promise<Uint8Array> {
    const cacheKey = `${name}:${kind}` as CacheKey;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = this.fetchBinary(`${this.basePath}/${artifacts[name][kind]}`);
    this.cache.set(cacheKey, promise);
    return promise;
  }

  private async fetchBinary(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load ${url} (${response.status})`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}
