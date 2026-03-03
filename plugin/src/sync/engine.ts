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

type PullMetrics = {
  skipped: boolean;
  events: number;
  applied: number;
  durationMs: number;
};

type PushMetrics = {
  candidates: number;
  prepared: number;
  uploads: number;
  operations: number;
  batches: number;
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
  private readonly localChangeGuardMs = 30_000;
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
        `pull=${pull.durationMs}ms(events=${pull.events},applied=${pull.applied}${pull.skipped ? ",skipped" : ""}) ` +
        `encrypt=${push.encryptMs}ms upload=${push.uploadMs}ms push=${push.pushMs}ms stagePushTotal=${push.durationMs}ms ` +
        `ops=${push.operations} uploads=${push.uploads} batches=${push.batches}`
      );
    } finally {
      this.activeRunProfile = prevProfile;
    }
  }

  markDirty(path: string) {
    if (!path) return;
    this.dirtyPaths.add(path);
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
    const candidates = this.collectCandidates();
    if (!candidates.length) {
      return {
        candidates: 0,
        prepared: 0,
        uploads: 0,
        operations: 0,
        batches: 0,
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
        encryptMs: Math.round(encryptMs),
        uploadMs: 0,
        pushMs: 0,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const uploads = prepared
      .filter(({ payload }) => !this.uploadedBlobHashes.has(payload.hash))
      .map(({ payload }) => payload);
    await this.runWithConcurrency(uploads, this.activeRunProfile.maxBlobUploadConcurrency, async (payload, idx) => {
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
      clientTs: file.stat.mtime
    }));

    for (let i = 0; i < operations.length; i += this.activeRunProfile.opBatchSize) {
      const chunk = operations.slice(i, i + this.activeRunProfile.opBatchSize);
      const pushStartedAt = performance.now();
      await this.requestJson<{ results: unknown[] }>("/api/v1/sync/push", {
        method: "POST",
        headers: this.authHeaders(),
        body: { operations: chunk }
      });
      pushMs += performance.now() - pushStartedAt;
      batches += 1;
      for (const op of chunk) {
        this.pushedMtime.set(op.path, op.clientTs);
      }
      await this.yieldToUi();
    }

    return {
      candidates: candidates.length,
      prepared: prepared.length,
      uploads: uploads.length,
      operations: operations.length,
      batches,
      encryptMs: Math.round(encryptMs),
      uploadMs: Math.round(uploadMs),
      pushMs: Math.round(pushMs),
      durationMs: Math.round(performance.now() - startedAt)
    };
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
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const data = await this.requestJson<{ events: PullEvent[]; nextAfterEventId: number }>("/api/v1/sync/pull", {
      method: "POST",
      headers: this.authHeaders(),
      body: { afterEventId: this.lastEventId, limit: this.activeRunProfile.pullLimit }
    });
    this.lastPullAt = Date.now();

    let applied = 0;
    for (const evt of data.events) {
      if (this.settings.deviceId && evt.deviceId === this.settings.deviceId) {
        continue;
      }
      try {
        await this.applyRemoteEvent(evt);
        applied += 1;
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
      durationMs: Math.round(performance.now() - startedAt)
    };
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

      if (this.shouldKeepLocalVersion(existing.path, existing.stat.mtime, evt.revisionTs)) {
        await this.writeRemoteConflictCopy(evt.path, text, evt.deviceId, evt.revisionTs);
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

  private shouldKeepLocalVersion(path: string, localMtime: number, remoteRevisionTs: number): boolean {
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (activePath && activePath === path) {
      return true;
    }

    const localIsRecent = Date.now() - localMtime <= this.localChangeGuardMs;
    const localIsNewer = localMtime > remoteRevisionTs;
    return localIsRecent || localIsNewer;
  }

  private async writeRemoteConflictCopy(
    originalPath: string,
    text: string,
    remoteDeviceId: string,
    revisionTs: number
  ) {
    await this.ensureFolder("_conflicts");
    const safeBase = originalPath
      .replace(/[<>:\"|?*]/g, "_")
      .replace(/[\\/]/g, "__");
    const suffix = `remote.${remoteDeviceId || "unknown"}.${revisionTs}`;
    let path = `_conflicts/${safeBase}.conflict.${suffix}.md`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `_conflicts/${safeBase}.conflict.${suffix}.${i}.md`;
      i += 1;
    }
    await this.app.vault.adapter.write(path, text);
  }

  private async ensureFolder(path: string) {
    if (this.app.vault.getAbstractFileByPath(path)) {
      return;
    }
    try {
      await this.app.vault.createFolder(path);
    } catch {
      // Folder might be created concurrently by another path.
    }
  }

  private debugPerf(message: string) {
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
