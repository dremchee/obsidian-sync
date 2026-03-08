import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { SyncSettings } from "../../settings";
import { SYNC_LIMITS } from "../constants";
import type { BatchBlobResponse, MissingBlobResponse } from "./types";
import { sha256Hex } from "./utils";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class EngineClient {
  constructor(
    private readonly settings: SyncSettings,
    private readonly debugPerf: (message: string) => void
  ) {}

  authHeaders() {
    return {
      authorization: `Bearer ${this.settings.apiKey}`,
      "content-type": "application/json"
    };
  }

  adminHeaders() {
    return {
      "x-auth-token": this.settings.authToken,
      "content-type": "application/json"
    };
  }

  async requestJson<T>(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown }
  ): Promise<T> {
    return this.withRetry(`${init.method || "GET"} ${path}`, async () => {
      try {
        const res = await requestUrl({
          url: this.endpoint(path),
          method: init.method || "GET",
          headers: init.headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          throw: false
        });
        if (res.status >= 400) {
          this.classifyHttpError(res.status, res.text, `${init.method || "GET"} ${path}`);
        }
        return res.json as T;
      } catch (err) {
        throw this.parseNetworkError(err, `${init.method || "GET"} ${path}`);
      }
    });
  }

  async registerDevice() {
    if (!this.settings.authToken) {
      throw new Error("Auth token is required");
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers["x-auth-token"] = this.settings.authToken;
    const data = await this.requestJson<{ apiKey: string; deviceId: string }>("/api/v1/device/register", {
      method: "POST",
      headers,
      body: {
        vaultName: this.settings.vaultName,
        deviceName: `${navigator.platform || "unknown"}-${Date.now()}`
      }
    });
    return { apiKey: data.apiKey, deviceId: data.deviceId };
  }

  async listVaults() {
    if (!this.settings.authToken) throw new Error("Auth token is required");
    return this.requestJson<{
      vaults: Array<{ id: string; name: string; createdAt: number; deviceCount: number }>;
    }>("/api/v1/vaults", { method: "GET", headers: this.adminHeaders() });
  }

  async createVault(name: string, passphrase: string) {
    if (!this.settings.authToken) throw new Error("Auth token is required");
    return this.requestJson<{ id: string; name: string; createdAt: number }>(
      "/api/v1/vaults",
      { method: "POST", headers: this.adminHeaders(), body: { name, passphrase } }
    );
  }

  async verifyPassphrase(vaultId: string, passphrase: string) {
    if (!this.settings.authToken) throw new Error("Auth token is required");
    return this.requestJson<{ valid: boolean }>(
      `/api/v1/vaults/${vaultId}/verify`,
      { method: "POST", headers: this.adminHeaders(), body: { passphrase } }
    );
  }

  async deleteVault(vaultId: string, passphrase: string) {
    if (!this.settings.authToken) throw new Error("Auth token is required");
    return this.requestJson<{ deleted: boolean }>(
      `/api/v1/vaults/${vaultId}`,
      { method: "DELETE", headers: this.adminHeaders(), body: { passphrase } }
    );
  }

  async listVaultDevices(vaultId: string) {
    if (!this.settings.authToken) throw new Error("Auth token is required");
    return this.requestJson<{
      devices: Array<{ id: string; name: string; createdAt: number; revokedAt: number | null }>;
    }>(`/api/v1/vaults/${vaultId}/devices`, { method: "GET", headers: this.adminHeaders() });
  }

  async filterMissingBlobs(payloads: Array<{ hash: string; bytes: Uint8Array }>) {
    if (!payloads.length) return payloads;
    const uniqHashes = Array.from(new Set(payloads.map((p) => p.hash)));
    try {
      const res = await this.requestJson<MissingBlobResponse>("/api/v1/blobs/missing", {
        method: "POST",
        headers: this.authHeaders(),
        body: { hashes: uniqHashes }
      });
      const missingSet = new Set((res.missing || []).map((h) => String(h).toLowerCase()));
      return payloads.filter((p) => missingSet.has(p.hash.toLowerCase()));
    } catch (err) {
      const status = this.parseStatusCode(err);
      if (status === 404) {
        return payloads;
      }
      throw err;
    }
  }

  async uploadBlob(hash: string, bytes: Uint8Array) {
    await this.uploadBinary(`/api/v1/blob/${hash}`, bytes);
  }

  async downloadBlob(hash: string) {
    const bytes = await this.requestBinary(`/api/v1/blob/${hash}`);
    await this.verifyBlobHash(hash, bytes);
    return bytes;
  }

  async downloadBlobsBatched(hashes: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const uniq = Array.from(new Set(hashes));
    if (!uniq.length) return out;

    const batchSize = Math.max(
      1,
      Math.min(SYNC_LIMITS.maxBlobBatchSize, this.settings.blobBatchSize || SYNC_LIMITS.defaultBlobBatchSize)
    );
    for (let i = 0; i < uniq.length; i += batchSize) {
      const chunk = uniq.slice(i, i + batchSize);
      const res = await this.requestJson<BatchBlobResponse>("/api/v1/blobs/get", {
        method: "POST",
        headers: this.authHeaders(),
        body: { hashes: chunk }
      });
      for (const item of res.items || []) {
        const bytes = this.fromB64(item.dataBase64);
        await this.verifyBlobHash(item.hash, bytes);
        out.set(item.hash, bytes);
      }
    }

    return out;
  }

  private endpoint(path: string) {
    const base = this.settings.serverUrl.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  private parseNetworkError(err: unknown, operation: string) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Failed to fetch/i.test(msg)) {
      return new Error(
        `${operation}: network error. Check Server URL (${this.settings.serverUrl}), backend is running, and port is reachable.`
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private classifyHttpError(status: number, text: string, operation: string) {
    if (status === 401 && /invalid or revoked api key|revoked/i.test(text)) {
      throw new Error(`DEVICE_REVOKED: ${operation} unauthorized (${status}).`);
    }
    throw new Error(`${operation} failed: ${status} ${text}`);
  }

  private parseStatusCode(err: unknown): number | null {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/\bfailed:\s*(\d{3})\b/i);
    return m ? Number.parseInt(m[1], 10) : null;
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof Error && /DEVICE_REVOKED/i.test(err.message)) return false;
    const status = this.parseStatusCode(err);
    if (status !== null) {
      return status === 408 || status === 425 || status === 429 || status >= 500;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return /network error|failed to fetch|timeout|econnreset|enotfound|econnrefused/i.test(msg);
  }

  private retryDelayMs(attempt: number): number {
    const base = Math.max(SYNC_LIMITS.minRetryBaseMs, this.settings.retryBaseMs || SYNC_LIMITS.defaultRetryBaseMs);
    const max = Math.max(base, this.settings.retryMaxMs || 30_000);
    const exp = Math.min(max, base * (2 ** attempt));
    return Math.floor(Math.random() * (exp + 1));
  }

  private async withRetry<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!this.isRetryableError(err) || attempt === maxAttempts - 1) {
          throw err;
        }
        const delayMs = this.retryDelayMs(attempt);
        this.debugPerf(`retry op=${opName} attempt=${attempt + 1} delayMs=${delayMs}`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${opName} failed`);
  }

  private async requestBinary(path: string): Promise<Uint8Array> {
    return this.withRetry(`GET ${path}`, async () => {
      try {
        const res: RequestUrlResponse = await requestUrl({
          url: this.endpoint(path),
          method: "GET",
          headers: {
            authorization: `Bearer ${this.settings.apiKey}`
          },
          throw: false
        });
        if (res.status >= 400) {
          this.classifyHttpError(res.status, res.text, `GET ${path}`);
        }
        return new Uint8Array(res.arrayBuffer);
      } catch (err) {
        throw this.parseNetworkError(err, `GET ${path}`);
      }
    });
  }

  private async uploadBinary(path: string, bytes: Uint8Array): Promise<void> {
    await this.withRetry(`PUT ${path}`, async () => {
      try {
        const res = await requestUrl({
          url: this.endpoint(path),
          method: "PUT",
          headers: {
            authorization: `Bearer ${this.settings.apiKey}`
          },
          body: toArrayBuffer(bytes),
          throw: false
        });
        if (res.status >= 400) {
          this.classifyHttpError(res.status, res.text, `PUT ${path}`);
        }
      } catch (err) {
        throw this.parseNetworkError(err, `PUT ${path}`);
      }
    });
  }

  private fromB64(s: string): Uint8Array {
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  private async verifyBlobHash(expectedHash: string, bytes: Uint8Array) {
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error(`BLOB_HASH_MISMATCH: expected ${expectedHash.toLowerCase()}, got ${actualHash}`);
    }
  }
}
