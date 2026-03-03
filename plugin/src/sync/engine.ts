import { App, requestUrl, RequestUrlResponse, TFile } from "obsidian";
import type { SyncSettings } from "../settings";
import { decryptBytes, encryptBytes, utf8Decode, utf8Encode } from "./crypto";

type PullEvent = {
  eventId: number;
  deviceId: string;
  path: string;
  op: "upsert" | "delete" | "rename";
  blobHash: string | null;
  size: number | null;
  revisionTs: number;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  const arr = new Uint8Array(digest);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SyncEngine {
  private app: App;
  private settings: SyncSettings;
  private lastEventId = 0;
  private pushedMtime = new Map<string, number>();
  private uploadedBlobHashes = new Set<string>();
  private remoteWriteSuppressUntil = new Map<string, number>();
  private lastPullAt = 0;
  private readonly maxFilesPerCycle = 25;

  constructor(app: App, settings: SyncSettings) {
    this.app = app;
    this.settings = settings;
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

  private async requestJson<T>(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown }
  ): Promise<T> {
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
  }

  private async requestBinary(path: string): Promise<Uint8Array> {
    try {
      const res: RequestUrlResponse = await requestUrl({
        url: this.endpoint(path),
        method: "GET",
        headers: { authorization: `Bearer ${this.settings.apiKey}` },
        throw: false
      });
      if (res.status >= 400) {
        this.classifyHttpError(res.status, res.text, `GET ${path}`);
      }
      return new Uint8Array(res.arrayBuffer);
    } catch (err) {
      throw this.parseNetworkError(err, `GET ${path}`);
    }
  }

  private async uploadBinary(path: string, bytes: Uint8Array): Promise<void> {
    try {
      const res = await requestUrl({
        url: this.endpoint(path),
        method: "PUT",
        headers: { authorization: `Bearer ${this.settings.apiKey}` },
        body: toArrayBuffer(bytes),
        throw: false
      });
      if (res.status >= 400) {
        this.classifyHttpError(res.status, res.text, `PUT ${path}`);
      }
    } catch (err) {
      throw this.parseNetworkError(err, `PUT ${path}`);
    }
  }

  async registerDevice() {
    const data = await this.requestJson<{ apiKey: string; deviceId: string }>("/api/v1/device/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        vaultName: this.settings.vaultName,
        deviceName: `${navigator.platform || "unknown"}-${Date.now()}`
      }
    });
    return { apiKey: data.apiKey, deviceId: data.deviceId };
  }

  async runOnce(options?: { forcePull?: boolean }) {
    if (!this.settings.apiKey || !this.settings.passphrase) return;
    await this.pullRemoteChanges(Boolean(options?.forcePull));
    await this.pushLocalChanges();
  }

  private authHeaders() {
    return {
      authorization: `Bearer ${this.settings.apiKey}`,
      "content-type": "application/json"
    };
  }

  private async pushLocalChanges() {
    const files = this.app.vault.getFiles();
    const operations: Array<{ operationId: string; op: "upsert"; path: string; blobHash: string; size: number; clientTs: number }> = [];
    let processed = 0;

    for (const file of files) {
      if (processed >= this.maxFilesPerCycle) break;
      const knownMtime = this.pushedMtime.get(file.path);
      if (knownMtime === file.stat.mtime) continue;

      const payload = await this.readAndEncryptFile(file);
      if (!this.uploadedBlobHashes.has(payload.hash)) {
        await this.uploadBlob(payload.hash, payload.bytes);
        this.uploadedBlobHashes.add(payload.hash);
      }
      operations.push({
        operationId: `${file.path}:${file.stat.mtime}`,
        op: "upsert",
        path: file.path,
        blobHash: payload.hash,
        size: payload.bytes.length,
        clientTs: file.stat.mtime
      });
      this.pushedMtime.set(file.path, file.stat.mtime);
      processed += 1;
    }

    if (!operations.length) return;
    await this.requestJson<{ results: unknown[] }>("/api/v1/sync/push", {
      method: "POST",
      headers: this.authHeaders(),
      body: { operations }
    });
  }

  private async pullRemoteChanges(force = false) {
    const now = Date.now();
    const minPullIntervalMs = Math.max(10, this.settings.intervalSec) * 1000;
    if (!force && now - this.lastPullAt < minPullIntervalMs) {
      return;
    }

    const data = await this.requestJson<{ events: PullEvent[]; nextAfterEventId: number }>("/api/v1/sync/pull", {
      method: "POST",
      headers: this.authHeaders(),
      body: { afterEventId: this.lastEventId, limit: 500 }
    });
    this.lastPullAt = Date.now();

    for (const evt of data.events) {
      if (this.settings.deviceId && evt.deviceId === this.settings.deviceId) {
        continue;
      }
      try {
        await this.applyRemoteEvent(evt);
      } catch (err) {
        if (this.isRecoverablePayloadError(err)) {
          console.warn(`[custom-sync] skipped corrupted payload for ${evt.path}: ${String(err)}`);
          continue;
        }
        throw err;
      }
    }

    this.lastEventId = data.nextAfterEventId;
  }

  private async applyRemoteEvent(evt: PullEvent) {
    if (evt.op === "delete") {
      this.markRemoteSuppressedPath(evt.path);
      const f = this.app.vault.getAbstractFileByPath(evt.path);
      if (f instanceof TFile) await this.app.vault.delete(f);
      return;
    }

    if (!evt.blobHash) return;
    const raw = await this.downloadBlob(evt.blobHash);
    let envelope: { salt: string; iv: string; ciphertext: string };
    try {
      envelope = JSON.parse(new TextDecoder().decode(raw)) as { salt: string; iv: string; ciphertext: string };
    } catch {
      throw new Error("CRYPTO_PAYLOAD_INVALID: blob is not valid JSON envelope");
    }
    const plain = await decryptBytes(this.settings.passphrase, envelope);

    const text = utf8Decode(plain);
    const existing = this.app.vault.getAbstractFileByPath(evt.path);
    if (existing instanceof TFile) {
      const currentText = await this.app.vault.cachedRead(existing);
      if (currentText === text) {
        this.pushedMtime.set(existing.path, existing.stat.mtime);
        return;
      }
    }
    this.markRemoteSuppressedPath(evt.path);
    await this.app.vault.adapter.write(evt.path, text);
  }

  private isRecoverablePayloadError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /CRYPTO_PAYLOAD_INVALID/i.test(msg);
  }

  private async uploadBlob(hash: string, bytes: Uint8Array) {
    await this.uploadBinary(`/api/v1/blob/${hash}`, bytes);
  }

  private async downloadBlob(hash: string) {
    return this.requestBinary(`/api/v1/blob/${hash}`);
  }

  private async readAndEncryptFile(file: TFile) {
    const text = await this.app.vault.cachedRead(file);
    const encrypted = await encryptBytes(this.settings.passphrase, utf8Encode(text));
    const bytes = utf8Encode(JSON.stringify(encrypted));
    const hash = await sha256Hex(bytes);
    return { hash, bytes };
  }

  shouldSuppressLocalEvent(path: string): boolean {
    const until = this.remoteWriteSuppressUntil.get(path);
    if (!until) return false;
    if (Date.now() <= until) return true;
    this.remoteWriteSuppressUntil.delete(path);
    return false;
  }

  private markRemoteSuppressedPath(path: string) {
    this.remoteWriteSuppressUntil.set(path, Date.now() + 5000);
  }
}
