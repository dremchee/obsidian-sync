import { App, TAbstractFile, TFile } from "obsidian";
import type { BootstrapPolicy, SyncSettings } from "../settings";
import { encryptBytes, utf8Encode } from "./crypto";
import { EngineClient } from "./engine/client";
import { ensureDirectory, ensureParentDirectory, readFileBytes, writeBinaryFile } from "./engine/file-io";
import {
  markRemoteSuppressedPath,
  shouldQueueLocalUpsert,
  shouldSuppressLocalEvent
} from "./engine/local-events";
import { prunePendingFileOperations, pruneTrackedPaths } from "./engine/prune";
import { runWithConcurrency, yieldToUi } from "./engine/runtime";
import { SyncRunner } from "./engine/runner";
import { SyncState } from "./engine/state";
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
  private readonly app: App;
  private readonly settings: SyncSettings;
  private readonly client: EngineClient;
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
      markRemoteSuppressedPath: (path, opts) => this.markRemoteSuppressedPath(path, opts),
      saveConflictCopy: (file, conflictPath) => this.saveConflictCopy(file, conflictPath),
      isRecoverablePayloadError: (err) => this.isRecoverablePayloadError(err),
      readAndEncryptFile: (file) => this.readAndEncryptFile(file),
      runWithConcurrency,
      yieldToUi
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

  beginBootstrap(policy: BootstrapPolicy) {
    this.state.beginBootstrap(policy, this.app.vault.getFiles());
  }

  resetState() {
    this.state.reset();
  }

  applyStateSnapshot(snapshot: Partial<EngineStateSnapshot> | null | undefined) {
    this.state.applySnapshot(snapshot);
    this.pruneFolderTrackedState();
  }

  getStateSnapshot(): EngineStateSnapshot {
    return this.state.snapshot();
  }

  private async saveConflictCopy(file: TFile, conflictPath: string) {
    this.markRemoteSuppressedPath(conflictPath);
    await ensureParentDirectory(this.app.vault, conflictPath);
    try {
      const content = await readFileBytes(this.app.vault, file);
      await writeBinaryFile(this.app.vault, conflictPath, content);
    } catch (err) {
      console.error(`[custom-sync] failed to save conflict copy ${conflictPath}: ${err}`);
    }
  }

  private async ensureDirectory(dirPath: string) {
    await ensureDirectory(this.app.vault, dirPath);
  }

  private isRecoverablePayloadError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /CRYPTO_PAYLOAD_INVALID/i.test(msg);
  }

  private async readAndEncryptFile(file: TFile) {
    const raw = await readFileBytes(this.app.vault, file);
    const encrypted = await encryptBytes(this.settings.passphrase, raw);
    const bytes = utf8Encode(JSON.stringify(encrypted));
    const hash = await sha256Hex(bytes);
    return { hash, bytes };
  }

  private debugPerf(message: string) {
    if (!this.settings.debugPerfLogs) return;
    console.debug(`[custom-sync][perf] ${message}`);
  }

  private pruneFolderTrackedState() {
    this.state.pendingOperations = prunePendingFileOperations(this.app.vault, this.state.pendingOperations);
    pruneTrackedPaths(this.state.headRevisionByPath, this.app.vault);
    pruneTrackedPaths(this.state.pushedMtime, this.app.vault);
    pruneTrackedPaths(this.state.bootstrapLocalPaths, this.app.vault);
  }

  shouldSuppressLocalEvent(path: string): boolean {
    return shouldSuppressLocalEvent(this.state.remoteWriteSuppressUntil, path);
  }

  shouldQueueLocalUpsert(file?: TAbstractFile | null): boolean {
    return shouldQueueLocalUpsert(this.state.remoteWriteSuppressUntil, this.state.pushedMtime, file);
  }

  private markRemoteSuppressedPath(path: string, opts?: { expectedMtime?: number; remainingPathEvents?: number }) {
    markRemoteSuppressedPath(this.state.remoteWriteSuppressUntil, path, opts);
  }
}
