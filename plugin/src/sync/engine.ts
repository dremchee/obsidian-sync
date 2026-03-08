import { App, TFile } from "obsidian";
import type { SyncSettings } from "../settings";
import { encryptBytes, utf8Encode } from "./crypto";
import { EngineClient } from "./engine/client";
import { SyncRunner } from "./engine/runner";
import {
  markRemoteSuppressedPath,
  SyncState,
  shouldSuppressLocalEvent
} from "./engine/state";
import {
  enqueueDelete,
  enqueueRename,
  enqueueUpsert
} from "./engine/queue";
import type {
  EngineStateSnapshot,
  RunProfile
} from "./engine/types";
import { sha256Hex } from "./engine/utils";

export type { EngineStateSnapshot } from "./engine/types";

export class SyncEngine {
  private app: App;
  private settings: SyncSettings;
  private client: EngineClient;
  private readonly state = new SyncState();
  private readonly runner: SyncRunner;
  private readonly defaultRunProfile: Required<RunProfile> = {
    maxFilesPerCycle: 20,
    fallbackScanChunkSize: 8,
    opBatchSize: 10,
    yieldEvery: 3,
    maxBlobUploadConcurrency: 2,
    pullLimit: 500
  };

  constructor(app: App, settings: SyncSettings) {
    this.app = app;
    this.settings = settings;
    this.client = new EngineClient(settings, (message) => this.debugPerf(message));
    this.runner = new SyncRunner({
      app,
      settings,
      state: this.state,
      client: this.client,
      defaultRunProfile: this.defaultRunProfile,
      debugPerf: (message) => this.debugPerf(message),
      ensureDirectory: (dirPath) => this.ensureDirectory(dirPath),
      markRemoteSuppressedPath: (path) => this.markRemoteSuppressedPath(path),
      saveConflictCopy: (file, conflictPath) => this.saveConflictCopy(file, conflictPath),
      isRecoverablePayloadError: (err) => this.isRecoverablePayloadError(err),
      readAndEncryptFile: (file) => this.readAndEncryptFile(file),
      runWithConcurrency: (items, concurrency, worker) => this.runWithConcurrency(items, concurrency, worker),
      yieldToUi: () => this.yieldToUi()
    });
  }

  async registerDevice() {
    return this.client.registerDevice();
  }

  async listVaults() {
    return this.client.listVaults();
  }

  async createVault(name: string, passphrase: string) {
    return this.client.createVault(name, passphrase);
  }

  async verifyPassphrase(vaultId: string, passphrase: string) {
    return this.client.verifyPassphrase(vaultId, passphrase);
  }

  async deleteVault(vaultId: string, passphrase: string) {
    return this.client.deleteVault(vaultId, passphrase);
  }

  async listVaultDevices(vaultId: string) {
    return this.client.listVaultDevices(vaultId);
  }

  async runOnce(options?: { forcePull?: boolean; profile?: RunProfile }) {
    await this.runner.runOnce(options);
  }

  markDirty(path: string) {
    enqueueUpsert(this.state.pendingOperations, path);
  }

  markFileDeleted(path: string) {
    enqueueDelete(this.state.pendingOperations, path);
  }

  markFileRenamed(prevPath: string, nextPath: string) {
    enqueueRename(this.state.pendingOperations, prevPath, nextPath);
  }

  markAllFilesDirty() {
    for (const file of this.app.vault.getFiles()) {
      enqueueUpsert(this.state.pendingOperations, file.path, file.stat.mtime);
    }
  }

  setNewVault(value: boolean) {
    this.state.isNewVault = value;
  }

  resetState() {
    this.state.reset();
  }

  applyStateSnapshot(snapshot: Partial<EngineStateSnapshot> | null | undefined) {
    this.state.applySnapshot(snapshot);
  }

  getStateSnapshot(): EngineStateSnapshot {
    return this.state.snapshot();
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

  private async readAndEncryptFile(file: TFile) {
    const text = await this.app.vault.cachedRead(file);
    const encrypted = await encryptBytes(this.settings.passphrase, utf8Encode(text));
    const bytes = utf8Encode(JSON.stringify(encrypted));
    const hash = await sha256Hex(bytes);
    return { hash, bytes };
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

  private debugPerf(message: string) {
    if (!this.settings.debugPerfLogs) return;
    console.debug(`[custom-sync][perf] ${message}`);
  }

  shouldSuppressLocalEvent(path: string): boolean {
    return shouldSuppressLocalEvent(this.state.remoteWriteSuppressUntil, path);
  }

  private markRemoteSuppressedPath(path: string) {
    markRemoteSuppressedPath(this.state.remoteWriteSuppressUntil, path);
  }
}
