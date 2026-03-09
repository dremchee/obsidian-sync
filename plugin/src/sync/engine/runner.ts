import { TFile, type App } from "obsidian";
import type { SyncSettings } from "../../settings";
import { SYNC_LIMITS } from "../constants";
import { collectFallbackOperations } from "./queue";
import { applyRemoteEvent } from "./remote";
import type { RemoteContext } from "./remote";
import { applyPushResult, buildPushOperation } from "./push";
import type { PushContext } from "./push";
import type {
  PendingLocalOperation,
  PullEvent,
  PullMetrics,
  PushMetrics,
  PushRequestOperation,
  PushResult,
  RunProfile
} from "./types";
import type { EngineClient } from "./client";
import type { SyncState } from "./state";

export type RunnerDeps = {
  app: App;
  settings: SyncSettings;
  state: SyncState;
  client: EngineClient;
  defaultRunProfile: Required<RunProfile>;
  debugPerf: (message: string) => void;
  ensureDirectory: (dirPath: string) => Promise<void>;
  markRemoteSuppressedPath: (path: string, opts?: { expectedMtime?: number; remainingPathEvents?: number }) => void;
  saveConflictCopy: (file: TFile, conflictPath: string) => Promise<void>;
  isRecoverablePayloadError: (err: unknown) => boolean;
  readAndEncryptFile: (file: TFile) => Promise<{ hash: string; bytes: Uint8Array }>;
  runWithConcurrency: <T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) => Promise<void>;
  yieldToUi: () => Promise<void>;
  setRunPhase?: (phase: "idle" | "pull" | "push") => void;
  setLastRunMetrics?: (metrics: { lastPullEvents: number; lastPullApplied: number; lastPushOperations: number }) => void;
};

export class SyncRunner {
  private activeRunProfile: Required<RunProfile>;

  constructor(private readonly deps: RunnerDeps) {
    this.activeRunProfile = deps.defaultRunProfile;
  }

  async runOnce(options?: { forcePull?: boolean; profile?: RunProfile }) {
    if (!this.deps.settings.apiKey || !this.deps.settings.passphrase) return;
    if (!this.deps.state.initialSyncDone && !this.deps.state.isNewVault && !this.deps.state.bootstrapPending) {
      this.deps.state.beginBootstrap(this.deps.settings.bootstrapPolicy, this.deps.app.vault.getFiles());
    }
    const prevProfile = this.activeRunProfile;
    this.activeRunProfile = {
      ...this.deps.defaultRunProfile,
      ...(options?.profile || {})
    };
    try {
      const startedAt = performance.now();
      this.deps.setRunPhase?.("pull");
      const pull = await this.pullRemoteChanges(Boolean(options?.forcePull));
      this.deps.setLastRunMetrics?.({
        lastPullEvents: pull.events,
        lastPullApplied: pull.applied,
        lastPushOperations: 0
      });

      if (!this.deps.state.initialSyncDone) {
        if (!this.deps.state.isNewVault) {
          const bootstrapPolicy = this.deps.state.bootstrapPolicy || this.deps.settings.bootstrapPolicy;
          if (bootstrapPolicy === "remote_wins") {
            this.deps.state.adoptRemoteWinsBaseline(this.deps.app.vault.getFiles());
            this.deps.state.completeBootstrap();
            this.deps.debugPerf(`initial sync: remote_wins baseline adopted`);
            const totalMs = Math.round(performance.now() - startedAt);
            this.deps.debugPerf(
              `run total=${totalMs}ms ` +
              `pull=${pull.durationMs}ms(events=${pull.events},applied=${pull.applied},conflicts=${pull.conflicts}${pull.skipped ? ",skipped" : ""})`
            );
            return;
          }

          if (bootstrapPolicy === "local_wins") {
            this.deps.state.queueBootstrapLocalFiles(this.deps.app.vault.getFiles());
            this.deps.debugPerf(`initial sync: local_wins pull-first, pushing preserved local files`);
          } else {
            this.deps.state.adoptRemoteMergeBaseline(this.deps.app.vault.getFiles());
            this.deps.debugPerf(`initial sync: merge pull-first, pushing local-only files`);
          }

          this.deps.setRunPhase?.("push");
          const push = await this.pushLocalChanges();
          this.deps.setLastRunMetrics?.({
            lastPullEvents: pull.events,
            lastPullApplied: pull.applied,
            lastPushOperations: push.operations
          });
          this.deps.state.completeBootstrap();
          const totalMs = Math.round(performance.now() - startedAt);
          this.deps.debugPerf(
            `run total=${totalMs}ms ` +
            `pull=${pull.durationMs}ms(events=${pull.events},applied=${pull.applied},conflicts=${pull.conflicts}${pull.skipped ? ",skipped" : ""}) ` +
            `encrypt=${push.encryptMs}ms upload=${push.uploadMs}ms push=${push.pushMs}ms stagePushTotal=${push.durationMs}ms ` +
            `ops=${push.operations} uploads=${push.uploads} batches=${push.batches} pushConflicts=${push.conflicts}`
          );
          return;
        }
        this.deps.debugPerf(`initial sync: new vault, proceeding with push`);
      }

      this.deps.setRunPhase?.("push");
      const push = await this.pushLocalChanges();
      this.deps.setLastRunMetrics?.({
        lastPullEvents: pull.events,
        lastPullApplied: pull.applied,
        lastPushOperations: push.operations
      });
      if (!this.deps.state.initialSyncDone) {
        this.deps.state.completeBootstrap();
      }
      const totalMs = Math.round(performance.now() - startedAt);

      this.deps.debugPerf(
        `run total=${totalMs}ms ` +
        `pull=${pull.durationMs}ms(events=${pull.events},applied=${pull.applied},conflicts=${pull.conflicts}${pull.skipped ? ",skipped" : ""}) ` +
        `encrypt=${push.encryptMs}ms upload=${push.uploadMs}ms push=${push.pushMs}ms stagePushTotal=${push.durationMs}ms ` +
        `ops=${push.operations} uploads=${push.uploads} batches=${push.batches} pushConflicts=${push.conflicts}`
      );
    } finally {
      this.deps.setRunPhase?.("idle");
      this.activeRunProfile = prevProfile;
    }
  }

  private async takePendingOperations() {
    const { nextDirectoryScanCursor } = await collectFallbackOperations({
      pendingOperations: this.deps.state.pendingOperations,
      files: this.deps.app.vault.getFiles(),
      pushedMtime: this.deps.state.pushedMtime,
      trackedFilesByDirectory: this.deps.state.trackedFilesByDirectory,
      knownDirectoryMtime: this.deps.state.knownDirectoryMtime,
      directoryScanCursor: this.deps.state.directoryScanCursor,
      fallbackScanChunkSize: this.activeRunProfile.fallbackScanChunkSize,
      statDirectory: async (path) => this.deps.app.vault.adapter?.stat ? this.deps.app.vault.adapter.stat(path) : null
    });
    this.deps.state.directoryScanCursor = nextDirectoryScanCursor;
    return this.deps.state.pendingOperations.slice(0, this.activeRunProfile.maxFilesPerCycle);
  }

  private async pushLocalChanges(): Promise<PushMetrics> {
    const startedAt = performance.now();
    let encryptMs = 0;
    let uploadMs = 0;
    let pushMs = 0;
    let batches = 0;
    let conflictCount = 0;

    const candidates = await this.takePendingOperations();
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

    const uploadsByOperationId = new Map<string, { hash: string; bytes: Uint8Array }>();
    let preparedCount = 0;
    for (const op of candidates) {
      if (op.op !== "upsert") continue;
      const file = this.deps.app.vault.getAbstractFileByPath(op.path);
      if (!(file instanceof TFile)) continue;

      const encryptStartedAt = performance.now();
      const payload = await this.deps.readAndEncryptFile(file);
      encryptMs += performance.now() - encryptStartedAt;
      uploadsByOperationId.set(op.operationId, payload);
      preparedCount += 1;
      if (preparedCount % this.activeRunProfile.yieldEvery === 0) {
        await this.deps.yieldToUi();
      }
    }

    const uploadCandidates = candidates
      .map((op) => uploadsByOperationId.get(op.operationId))
      .filter((payload): payload is { hash: string; bytes: Uint8Array } => Boolean(payload))
      .filter((payload) => !this.deps.state.uploadedBlobHashes.has(payload.hash));
    const uploads = await this.deps.client.filterMissingBlobs(uploadCandidates);
    const uploadConcurrency = Math.max(1, this.deps.settings.maxConcurrentUploads || this.activeRunProfile.maxBlobUploadConcurrency);
    await this.deps.runWithConcurrency(uploads, uploadConcurrency, async (payload, idx) => {
      const uploadStartedAt = performance.now();
      await this.deps.client.uploadBlob(payload.hash, payload.bytes);
      uploadMs += performance.now() - uploadStartedAt;
      this.deps.state.uploadedBlobHashes.add(payload.hash);
      if ((idx + 1) % this.activeRunProfile.yieldEvery === 0) {
        await this.deps.yieldToUi();
      }
    });

    const builtOps: { pending: PendingLocalOperation; requestOp: PushRequestOperation }[] = [];
    for (const pending of candidates) {
      const requestOp = await buildPushOperation(
        { app: this.deps.app, state: this.deps.state },
        pending,
        uploadsByOperationId
      );
      if (!requestOp) {
        this.deps.state.pendingOperations = this.deps.state.pendingOperations.filter((op) => op.operationId !== pending.operationId);
        continue;
      }
      builtOps.push({ pending, requestOp });
    }

    const batchSize = this.activeRunProfile.opBatchSize;
    let processed = 0;
    const pushContext: PushContext = {
      app: this.deps.app,
      state: this.deps.state,
      ensureDirectory: this.deps.ensureDirectory,
      markRemoteSuppressedPath: this.deps.markRemoteSuppressedPath,
      debugPerf: this.deps.debugPerf
    };
    for (let i = 0; i < builtOps.length; i += batchSize) {
      const batch = builtOps.slice(i, i + batchSize);
      const pushStartedAt = performance.now();
      const res = await this.deps.client.requestJson<{ results: PushResult[] }>("/api/v1/sync/push", {
        method: "POST",
        headers: this.deps.client.authHeaders(),
        body: { operations: batch.map((b) => b.requestOp) }
      });
      pushMs += performance.now() - pushStartedAt;
      batches += 1;

      for (const { pending, requestOp } of batch) {
        const result = (res.results || []).find((item) => item.operationId === requestOp.operationId);
        if (!result) {
          throw new Error(`push missing result for operation ${requestOp.operationId}`);
        }

        this.deps.state.pendingOperations = await applyPushResult(pushContext, pending, requestOp, result);
        processed += 1;
        if (processed % this.activeRunProfile.yieldEvery === 0) {
          await this.deps.yieldToUi();
        }
        if (result.status === "conflict") {
          conflictCount += 1;
        }
      }
    }

    return {
      candidates: candidates.length,
      prepared: preparedCount,
      uploads: uploads.length,
      operations: processed,
      batches,
      conflicts: conflictCount,
      encryptMs: Math.round(encryptMs),
      uploadMs: Math.round(uploadMs),
      pushMs: Math.round(pushMs),
      durationMs: Math.round(performance.now() - startedAt)
    };
  }

  private async pullRemoteChanges(force = false): Promise<PullMetrics> {
    const startedAt = performance.now();
    const now = Date.now();
    const minPullIntervalMs = Math.max(SYNC_LIMITS.minPullIntervalSec, this.deps.settings.intervalSec) * 1000;
    if (!force && now - this.deps.state.lastPullAt < minPullIntervalMs) {
      return {
        skipped: true,
        events: 0,
        applied: 0,
        conflicts: 0,
        durationMs: Math.round(performance.now() - startedAt)
      };
    }

    const limit = Math.max(
      1,
      Math.min(SYNC_LIMITS.maxPullBatchSize, this.deps.settings.pullBatchSize || this.activeRunProfile.pullLimit)
    );
    const maxPages = SYNC_LIMITS.maxPullPagesPerRun;
    let page = 0;
    let totalEvents = 0;
    let applied = 0;
    let conflictCount = 0;
    const remoteContext: RemoteContext = {
      app: this.deps.app,
      settings: this.deps.settings,
      state: this.deps.state,
      downloadBlob: (hash) => this.deps.client.downloadBlob(hash),
      saveConflictCopy: this.deps.saveConflictCopy,
      ensureDirectory: this.deps.ensureDirectory,
      markRemoteSuppressedPath: this.deps.markRemoteSuppressedPath,
      debugPerf: this.deps.debugPerf
    };

    while (page < maxPages) {
      const data = await this.deps.client.requestJson<{ events: PullEvent[]; nextAfterEventId: number }>("/api/v1/sync/pull", {
        method: "POST",
        headers: this.deps.client.authHeaders(),
        body: {
          afterEventId: this.deps.state.lastEventId,
          limit,
          includeDeleted: true
        }
      });
      this.deps.state.lastPullAt = Date.now();

      if (!data.events.length) {
        break;
      }

      totalEvents += data.events.length;
      for (const evt of data.events) {
        if (!evt.revisionId) continue;
        if (evt.op === "rename" && evt.prevPath) {
          this.deps.state.headRevisionByPath.delete(evt.prevPath);
        }
        this.deps.state.headRevisionByPath.set(evt.path, evt.revisionId);
      }

      const batchedBlobs = await this.deps.client.downloadBlobsBatched(
        data.events
          .filter((evt) => !this.deps.settings.deviceId || evt.deviceId !== this.deps.settings.deviceId)
          .filter((evt) => evt.op === "upsert")
          .map((evt) => evt.blobHash)
          .filter((h): h is string => Boolean(h))
      );

      for (const evt of data.events) {
        if (this.deps.settings.deviceId && evt.deviceId === this.deps.settings.deviceId) {
          continue;
        }
        try {
          const remoteResult = await applyRemoteEvent(remoteContext, evt, batchedBlobs);
          this.deps.state.pendingOperations = remoteResult.pendingOperations;
          applied += 1;
          if (remoteResult.wasConflict) conflictCount += 1;
          if (applied % this.activeRunProfile.yieldEvery === 0) {
            await this.deps.yieldToUi();
          }
        } catch (err) {
          if (this.deps.isRecoverablePayloadError(err)) {
            console.warn(`[custom-sync] skipped corrupted payload for ${evt.path}: ${String(err)}`);
            continue;
          }
          throw err;
        }
      }

      this.deps.state.lastEventId = data.nextAfterEventId;
      page += 1;
      if (data.events.length < limit) {
        break;
      }
      await this.deps.yieldToUi();
    }

    return {
      skipped: false,
      events: totalEvents,
      applied,
      conflicts: conflictCount,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
}
