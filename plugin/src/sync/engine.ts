import { App, Notice, requestUrl, RequestUrlResponse, TFile } from "obsidian";
import type { SyncSettings } from "../settings";
import { decryptBytes, encryptBytes, utf8Decode, utf8Encode } from "./crypto";
import { makeConflictPath } from "./conflicts";

type PullEvent = {
  eventId: number;
  revisionId: string;
  deviceId: string;
  path: string;
  op: "upsert" | "delete" | "rename";
  blobHash: string | null;
  size: number | null;
  revisionTs: number;
};

type BatchBlobResponse = {
  items: Array<{ hash: string; dataBase64: string }>;
  missing: string[];
};

type MissingBlobResponse = {
  missing: string[];
};

type PushResult = {
  operationId: string;
  status: "applied" | "duplicate" | "ignored" | "conflict";
  revisionId?: string;
  headRevisionId?: string;
  conflictPath?: string;
};

type PullMetrics = {
  skipped: boolean;
  events: number;
  applied: number;
  conflicts: number;
  durationMs: number;
};

type PushMetrics = {
  candidates: number;
  prepared: number;
  uploads: number;
  operations: number;
  batches: number;
  conflicts: number;
  encryptMs: number;
  uploadMs: number;
  pushMs: number;
  durationMs: number;
};

type RunProfile = {
  maxFilesPerCycle?: number;
  fallbackScanChunkSize?: number;
  opBatchSize?: number;
  yieldEvery?: number;
  maxBlobUploadConcurrency?: number;
  pullLimit?: number;
};

export type EngineStateSnapshot = {
  lastEventId: number;
  dirtyPaths: string[];
  uploadedBlobHashes: string[];
  headRevisionByPath: Record<string, string>;
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
  private readonly headRevisionByPath = new Map<string, string>();
  private pushedMtime = new Map<string, number>();
  private uploadedBlobHashes = new Set<string>();
  private remoteWriteSuppressUntil = new Map<string, number>();
  private lastPullAt = 0;
  private readonly defaultRunProfile: Required<RunProfile> = {
    maxFilesPerCycle: 20,
    fallbackScanChunkSize: 8,
    opBatchSize: 10,
    yieldEvery: 3,
    maxBlobUploadConcurrency: 2,
    pullLimit: 500
  };
  private activeRunProfile: Required<RunProfile> = { ...this.defaultRunProfile };
  private readonly dirtyPaths = new Set<string>();
  private scanCursor = 0;

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
    const base = Math.max(100, this.settings.retryBaseMs || 500);
    const max = Math.max(base, this.settings.retryMaxMs || 30_000);
    const exp = Math.min(max, base * (2 ** attempt));
    // Full jitter: random delay in [0, exp], better at desynchronizing retries.
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

  private async requestJson<T>(
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

  async runOnce(options?: { forcePull?: boolean; profile?: RunProfile }) {
    if (!this.settings.apiKey || !this.settings.passphrase) return;
    const prevProfile = this.activeRunProfile;
    this.activeRunProfile = {
      ...this.defaultRunProfile,
      ...(options?.profile || {})
    };
    try {
      const startedAt = performance.now();
      const pull = await this.pullRemoteChanges(Boolean(options?.forcePull));
      const push = await this.pushLocalChanges();
      const totalMs = Math.round(performance.now() - startedAt);

      this.debugPerf(
        `run total=${totalMs}ms ` +
        `pull=${pull.durationMs}ms(events=${pull.events},applied=${pull.applied},conflicts=${pull.conflicts}${pull.skipped ? ",skipped" : ""}) ` +
        `encrypt=${push.encryptMs}ms upload=${push.uploadMs}ms push=${push.pushMs}ms stagePushTotal=${push.durationMs}ms ` +
        `ops=${push.operations} uploads=${push.uploads} batches=${push.batches} pushConflicts=${push.conflicts}`
      );
    } finally {
      this.activeRunProfile = prevProfile;
    }
  }

  markDirty(path: string) {
    if (!path) return;
    this.dirtyPaths.add(path);
  }

  applyStateSnapshot(snapshot: Partial<EngineStateSnapshot> | null | undefined) {
    if (!snapshot || typeof snapshot !== "object") return;
    if (Number.isFinite(snapshot.lastEventId)) {
      this.lastEventId = Math.max(0, Number(snapshot.lastEventId));
    }
    if (Array.isArray(snapshot.dirtyPaths)) {
      this.dirtyPaths.clear();
      for (const p of snapshot.dirtyPaths) {
        if (typeof p === "string" && p) this.dirtyPaths.add(p);
      }
    }
    if (Array.isArray(snapshot.uploadedBlobHashes)) {
      this.uploadedBlobHashes.clear();
      for (const h of snapshot.uploadedBlobHashes) {
        if (typeof h === "string" && /^[a-f0-9]{64}$/i.test(h)) this.uploadedBlobHashes.add(h.toLowerCase());
      }
    }
    if (snapshot.headRevisionByPath && typeof snapshot.headRevisionByPath === "object") {
      this.headRevisionByPath.clear();
      for (const [k, v] of Object.entries(snapshot.headRevisionByPath)) {
        if (typeof v === "string" && v) this.headRevisionByPath.set(k, v);
      }
    }
  }

  getStateSnapshot(): EngineStateSnapshot {
    return {
      lastEventId: this.lastEventId,
      dirtyPaths: Array.from(this.dirtyPaths),
      uploadedBlobHashes: Array.from(this.uploadedBlobHashes),
      headRevisionByPath: Object.fromEntries(this.headRevisionByPath.entries())
    };
  }

  private authHeaders() {
    return {
      authorization: `Bearer ${this.settings.apiKey}`,
      "content-type": "application/json"
    };
  }

  private async pushLocalChanges(): Promise<PushMetrics> {
    const startedAt = performance.now();
    let encryptMs = 0;
    let uploadMs = 0;
    let pushMs = 0;
    let batches = 0;
    let conflictCount = 0;
    const candidates = this.collectCandidates();
    if (!candidates.length) {
      return {
        candidates: 0,
        prepared: 0,
        uploads: 0,
        operations: 0,
        batches: 0,
        conflicts: 0,
        encryptMs: 0,
        uploadMs: 0,
        pushMs: 0,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const prepared: Array<{ file: TFile; payload: { hash: string; bytes: Uint8Array } }> = [];
    let preparedCount = 0;

    for (const file of candidates) {
      const knownMtime = this.pushedMtime.get(file.path);
      if (knownMtime === file.stat.mtime) {
        this.dirtyPaths.delete(file.path);
        continue;
      }
      const encryptStartedAt = performance.now();
      const payload = await this.readAndEncryptFile(file);
      encryptMs += performance.now() - encryptStartedAt;
      prepared.push({ file, payload });
      preparedCount += 1;
      this.dirtyPaths.delete(file.path);
      if (preparedCount % this.activeRunProfile.yieldEvery === 0) {
        await this.yieldToUi();
      }
    }

    if (!prepared.length) {
      return {
        candidates: candidates.length,
        prepared: 0,
        uploads: 0,
        operations: 0,
        batches: 0,
        conflicts: 0,
        encryptMs: Math.round(encryptMs),
        uploadMs: 0,
        pushMs: 0,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const uploadCandidates = prepared
      .filter(({ payload }) => !this.uploadedBlobHashes.has(payload.hash))
      .map(({ payload }) => payload);
    const uploads = await this.filterMissingBlobs(uploadCandidates);
    const uploadConcurrency = Math.max(1, this.settings.maxConcurrentUploads || this.activeRunProfile.maxBlobUploadConcurrency);
    await this.runWithConcurrency(uploads, uploadConcurrency, async (payload, idx) => {
      const uploadStartedAt = performance.now();
      await this.uploadBlob(payload.hash, payload.bytes);
      uploadMs += performance.now() - uploadStartedAt;
      this.uploadedBlobHashes.add(payload.hash);
      if ((idx + 1) % this.activeRunProfile.yieldEvery === 0) {
        await this.yieldToUi();
      }
    });

    const operations = prepared.map(({ file, payload }) => ({
      operationId: `${file.path}:${file.stat.mtime}`,
      op: "upsert" as const,
      path: file.path,
      blobHash: payload.hash,
      size: payload.bytes.length,
      clientTs: file.stat.mtime,
      baseRevisionId: this.headRevisionByPath.get(file.path)
    }));

    for (let i = 0; i < operations.length; i += this.activeRunProfile.opBatchSize) {
      const chunk = operations.slice(i, i + this.activeRunProfile.opBatchSize);
      const pushStartedAt = performance.now();
      const res = await this.requestJson<{ results: PushResult[] }>("/api/v1/sync/push", {
        method: "POST",
        headers: this.authHeaders(),
        body: { operations: chunk }
      });
      pushMs += performance.now() - pushStartedAt;
      batches += 1;
      for (const op of chunk) {
        this.pushedMtime.set(op.path, op.clientTs);
      }
      for (const r of res.results || []) {
        const op = chunk.find((c) => c.operationId === r.operationId);
        if (!op) continue;

        if (r.status === "conflict" && r.conflictPath) {
          conflictCount += 1;
          await this.handlePushConflict(op.path, r.conflictPath, r.headRevisionId);
          continue;
        }

        const head = r.headRevisionId || r.revisionId;
        if (head) {
          this.headRevisionByPath.set(op.path, head);
        }
      }
      await this.yieldToUi();
    }

    return {
      candidates: candidates.length,
      prepared: prepared.length,
      uploads: uploads.length,
      operations: operations.length,
      batches,
      conflicts: conflictCount,
      encryptMs: Math.round(encryptMs),
      uploadMs: Math.round(uploadMs),
      pushMs: Math.round(pushMs),
      durationMs: Math.round(performance.now() - startedAt)
    };
  }

  private async handlePushConflict(originalPath: string, conflictPath: string, headRevisionId?: string) {
    const file = this.app.vault.getAbstractFileByPath(originalPath);
    if (!(file instanceof TFile)) return;

    this.markRemoteSuppressedPath(conflictPath);
    this.markRemoteSuppressedPath(originalPath);

    try {
      // Ensure parent directory exists for conflict path
      const parentDir = conflictPath.substring(0, conflictPath.lastIndexOf("/"));
      if (parentDir) {
        await this.ensureDirectory(parentDir);
      }
      await this.app.vault.rename(file, conflictPath);
      this.debugPerf(`conflict: renamed ${originalPath} -> ${conflictPath}`);
    } catch {
      // If rename fails, copy the content instead
      try {
        const content = await this.app.vault.cachedRead(file);
        await this.app.vault.adapter.write(conflictPath, content);
        this.debugPerf(`conflict: copied ${originalPath} -> ${conflictPath}`);
      } catch (copyErr) {
        console.error(`[custom-sync] failed to create conflict copy: ${copyErr}`);
        return;
      }
    }

    // Mark conflict copy as dirty so it gets pushed
    this.dirtyPaths.add(conflictPath);
    // Clear mtime so next pull can write the winning version to original path
    this.pushedMtime.delete(originalPath);

    if (headRevisionId) {
      this.headRevisionByPath.set(originalPath, headRevisionId);
    }
  }

  private async pullRemoteChanges(force = false): Promise<PullMetrics> {
    const startedAt = performance.now();
    const now = Date.now();
    const minPullIntervalMs = Math.max(10, this.settings.intervalSec) * 1000;
    if (!force && now - this.lastPullAt < minPullIntervalMs) {
      return {
        skipped: true,
        events: 0,
        applied: 0,
        conflicts: 0,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const data = await this.requestJson<{ events: PullEvent[]; nextAfterEventId: number }>("/api/v1/sync/pull", {
      method: "POST",
      headers: this.authHeaders(),
      body: {
        afterEventId: this.lastEventId,
        limit: Math.max(1, Math.min(1000, this.settings.pullBatchSize || this.activeRunProfile.pullLimit)),
        includeDeleted: true
      }
    });
    this.lastPullAt = Date.now();
    for (const evt of data.events) {
      if (evt.revisionId) {
        this.headRevisionByPath.set(evt.path, evt.revisionId);
      }
    }
    const batchedBlobs = await this.downloadBlobsBatched(
      data.events
        .filter((evt) => !this.settings.deviceId || evt.deviceId !== this.settings.deviceId)
        .map((evt) => evt.blobHash)
        .filter((h): h is string => Boolean(h))
    );

    let applied = 0;
    let conflictCount = 0;
    for (const evt of data.events) {
      if (this.settings.deviceId && evt.deviceId === this.settings.deviceId) {
        continue;
      }
      try {
        const wasConflict = await this.applyRemoteEvent(evt, batchedBlobs);
        applied += 1;
        if (wasConflict) conflictCount += 1;
        if (applied % this.activeRunProfile.yieldEvery === 0) {
          await this.yieldToUi();
        }
      } catch (err) {
        if (this.isRecoverablePayloadError(err)) {
          console.warn(`[custom-sync] skipped corrupted payload for ${evt.path}: ${String(err)}`);
          continue;
        }
        throw err;
      }
    }

    this.lastEventId = data.nextAfterEventId;
    return {
      skipped: false,
      events: data.events.length,
      applied,
      conflicts: conflictCount,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }

  private async applyRemoteEvent(evt: PullEvent, prefetchedBlobs?: Map<string, Uint8Array>): Promise<boolean> {
    if (evt.op === "delete") {
      // If file has local modifications, save as conflict copy before deleting
      if (this.dirtyPaths.has(evt.path)) {
        const f = this.app.vault.getAbstractFileByPath(evt.path);
        if (f instanceof TFile) {
          const conflictPath = makeConflictPath(evt.path, this.settings.deviceId || "local", Date.now());
          await this.saveConflictCopy(f, conflictPath);
          this.debugPerf(`conflict on delete: saved ${evt.path} -> ${conflictPath}`);
          this.dirtyPaths.delete(evt.path);
          this.dirtyPaths.add(conflictPath);
        }
      }

      this.markRemoteSuppressedPath(evt.path);
      const f = this.app.vault.getAbstractFileByPath(evt.path);
      if (f instanceof TFile) await this.app.vault.delete(f);
      return false;
    }

    if (!evt.blobHash) return false;
    const raw = prefetchedBlobs?.get(evt.blobHash) || await this.downloadBlob(evt.blobHash);
    let envelope: { salt: string; iv: string; ciphertext: string };
    try {
      envelope = JSON.parse(new TextDecoder().decode(raw)) as { salt: string; iv: string; ciphertext: string };
    } catch {
      throw new Error("CRYPTO_PAYLOAD_INVALID: blob is not valid JSON envelope");
    }
    const plain = await decryptBytes(this.settings.passphrase, envelope);

    const text = utf8Decode(plain);
    const existing = this.app.vault.getAbstractFileByPath(evt.path);
    let wasConflict = false;

    if (existing instanceof TFile) {
      const currentText = await this.app.vault.cachedRead(existing);
      if (currentText === text) {
        this.pushedMtime.set(existing.path, existing.stat.mtime);
        return false;
      }

      // Check if file has local dirty changes — this is a conflict
      if (this.dirtyPaths.has(evt.path)) {
        const conflictPath = makeConflictPath(evt.path, this.settings.deviceId || "local", Date.now());
        await this.saveConflictCopy(existing, conflictPath);
        this.debugPerf(`conflict on pull: saved ${evt.path} -> ${conflictPath}`);
        this.dirtyPaths.delete(evt.path);
        this.dirtyPaths.add(conflictPath);
        wasConflict = true;
      } else {
        this.debugPerf(`lww overwrite path=${evt.path} remoteTs=${evt.revisionTs} localMtime=${existing.stat.mtime}`);
      }
    }

    this.markRemoteSuppressedPath(evt.path);
    await this.app.vault.adapter.write(evt.path, text);
    return wasConflict;
  }

  private async saveConflictCopy(file: TFile, conflictPath: string) {
    this.markRemoteSuppressedPath(conflictPath);
    const parentDir = conflictPath.substring(0, conflictPath.lastIndexOf("/"));
    if (parentDir) {
      await this.ensureDirectory(parentDir);
    }
    try {
      const content = await this.app.vault.cachedRead(file);
      await this.app.vault.adapter.write(conflictPath, content);
    } catch (err) {
      console.error(`[custom-sync] failed to save conflict copy ${conflictPath}: ${err}`);
    }
  }

  private async ensureDirectory(dirPath: string) {
    if (await this.app.vault.adapter.exists(dirPath)) return;
    await this.app.vault.adapter.mkdir(dirPath);
  }

  private isRecoverablePayloadError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /CRYPTO_PAYLOAD_INVALID/i.test(msg);
  }

  private async uploadBlob(hash: string, bytes: Uint8Array) {
    await this.uploadBinary(`/api/v1/blob/${hash}`, bytes);
  }

  private async filterMissingBlobs(payloads: Array<{ hash: string; bytes: Uint8Array }>) {
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
      // Backward compatibility: old server without missing endpoint.
      if (status === 404) {
        return payloads;
      }
      throw err;
    }
  }

  private async downloadBlob(hash: string) {
    return this.requestBinary(`/api/v1/blob/${hash}`);
  }

  private async downloadBlobsBatched(hashes: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const uniq = Array.from(new Set(hashes));
    if (!uniq.length) return out;

    const batchSize = Math.max(1, Math.min(100, this.settings.blobBatchSize || 20));
    for (let i = 0; i < uniq.length; i += batchSize) {
      const chunk = uniq.slice(i, i + batchSize);
      const res = await this.requestJson<BatchBlobResponse>("/api/v1/blobs/get", {
        method: "POST",
        headers: this.authHeaders(),
        body: { hashes: chunk }
      });
      for (const item of res.items || []) {
        out.set(item.hash, this.fromB64(item.dataBase64));
      }
      await this.yieldToUi();
    }

    return out;
  }

  private async readAndEncryptFile(file: TFile) {
    const text = await this.app.vault.cachedRead(file);
    const encrypted = await encryptBytes(this.settings.passphrase, utf8Encode(text));
    const bytes = utf8Encode(JSON.stringify(encrypted));
    const hash = await sha256Hex(bytes);
    return { hash, bytes };
  }

  private collectCandidates(): TFile[] {
    const files = this.app.vault.getFiles();
    if (!files.length) return [];

    const out: TFile[] = [];
    const dirtyQueue = Array.from(this.dirtyPaths);
    for (const path of dirtyQueue) {
      if (out.length >= this.activeRunProfile.maxFilesPerCycle) break;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        out.push(file);
      } else {
        this.dirtyPaths.delete(path);
      }
    }

    if (out.length >= this.activeRunProfile.maxFilesPerCycle) return out;

    const remaining = Math.min(
      this.activeRunProfile.maxFilesPerCycle - out.length,
      this.activeRunProfile.fallbackScanChunkSize,
      files.length
    );
    for (let i = 0; i < remaining; i += 1) {
      const idx = (this.scanCursor + i) % files.length;
      out.push(files[idx]);
    }
    this.scanCursor = (this.scanCursor + remaining) % files.length;
    return out;
  }

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>
  ) {
    if (!items.length) return;
    let index = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (true) {
        const current = index;
        index += 1;
        if (current >= items.length) return;
        await worker(items[current], current);
      }
    });
    await Promise.all(workers);
  }

  private async yieldToUi() {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  private fromB64(s: string): Uint8Array {
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  private debugPerf(message: string) {
    if (!this.settings.debugPerfLogs) return;
    console.debug(`[custom-sync][perf] ${message}`);
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
