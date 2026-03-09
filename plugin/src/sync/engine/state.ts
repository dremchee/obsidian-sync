import type { BootstrapPolicy } from "../../settings";
import type { TFile } from "obsidian";
import type { RemoteWriteSuppression } from "./local-events";
import { enqueueUpsert, normalizePendingOperation } from "./queue";
import { CURRENT_ENGINE_STATE_VERSION } from "./snapshot";
import type { EngineStateSnapshot, PendingLocalOperation } from "./types";
import { newOperationId, normalizePath } from "./utils";

export class SyncState {
  lastEventId = 0;
  readonly headRevisionByPath = new Map<string, string>();
  readonly pushedMtime = new Map<string, number>();
  readonly uploadedBlobHashes = new Set<string>();
  readonly remoteWriteSuppressUntil = new Map<string, RemoteWriteSuppression>();
  readonly bootstrapLocalPaths = new Set<string>();
  readonly trackedFilesByDirectory = new Map<string, Set<string>>();
  readonly knownDirectoryMtime = new Map<string, number>();
  pendingOperations: PendingLocalOperation[] = [];
  initialSyncDone = false;
  isNewVault = false;
  bootstrapPending = false;
  bootstrapPolicy: BootstrapPolicy | null = null;
  lastPullAt = 0;
  directoryScanCursor = 0;

  reset() {
    this.lastEventId = 0;
    this.headRevisionByPath.clear();
    this.pushedMtime.clear();
    this.uploadedBlobHashes.clear();
    this.remoteWriteSuppressUntil.clear();
    this.bootstrapLocalPaths.clear();
    this.trackedFilesByDirectory.clear();
    this.knownDirectoryMtime.clear();
    this.pendingOperations = [];
    this.initialSyncDone = false;
    this.isNewVault = false;
    this.bootstrapPending = false;
    this.bootstrapPolicy = null;
    this.lastPullAt = 0;
    this.directoryScanCursor = 0;
  }

  applySnapshot(snapshot: Partial<EngineStateSnapshot> | null | undefined) {
    if (!snapshot || typeof snapshot !== "object") return;

    if (Number.isFinite(snapshot.lastEventId)) {
      this.lastEventId = Math.max(0, Number(snapshot.lastEventId));
    }
    this.initialSyncDone = Boolean(snapshot.initialSyncDone);

    const pendingOperations: PendingLocalOperation[] = [];
    if (Array.isArray(snapshot.pendingOperations)) {
      for (const op of snapshot.pendingOperations) {
        const normalized = normalizePendingOperation(op);
        if (normalized) pendingOperations.push(normalized);
      }
    } else if (Array.isArray(snapshot.dirtyPaths)) {
      for (const path of snapshot.dirtyPaths) {
        const normalizedPath = normalizePath(path);
        if (!normalizedPath) continue;
        pendingOperations.push({
          operationId: newOperationId(),
          op: "upsert",
          path: normalizedPath,
          clientTs: Date.now()
        });
      }
    }
    this.pendingOperations = pendingOperations;

    this.uploadedBlobHashes.clear();
    if (Array.isArray(snapshot.uploadedBlobHashes)) {
      for (const h of snapshot.uploadedBlobHashes) {
        if (typeof h === "string" && /^[a-f0-9]{64}$/i.test(h)) this.uploadedBlobHashes.add(h.toLowerCase());
      }
    }

    this.pushedMtime.clear();
    if (snapshot.pushedMtimeByPath && typeof snapshot.pushedMtimeByPath === "object") {
      for (const [path, value] of Object.entries(snapshot.pushedMtimeByPath)) {
        if (Number.isFinite(value)) {
          this.pushedMtime.set(path, Math.max(0, Number(value)));
        }
      }
    }

    this.headRevisionByPath.clear();
    if (snapshot.headRevisionByPath && typeof snapshot.headRevisionByPath === "object") {
      for (const [k, v] of Object.entries(snapshot.headRevisionByPath)) {
        if (typeof v === "string" && v) this.headRevisionByPath.set(k, v);
      }
    }

    if (snapshot.isNewVault) {
      this.isNewVault = true;
    }

    this.bootstrapPending = Boolean(snapshot.bootstrapPending);
    this.bootstrapPolicy =
      snapshot.bootstrapPolicy === "merge" ||
      snapshot.bootstrapPolicy === "remote_wins" ||
      snapshot.bootstrapPolicy === "local_wins"
        ? snapshot.bootstrapPolicy
        : null;

    this.bootstrapLocalPaths.clear();
    if (Array.isArray(snapshot.bootstrapLocalPaths)) {
      for (const path of snapshot.bootstrapLocalPaths) {
        const normalizedPath = normalizePath(path);
        if (normalizedPath) {
          this.bootstrapLocalPaths.add(normalizedPath);
        }
      }
    }
  }

  snapshot(): EngineStateSnapshot {
    return {
      version: CURRENT_ENGINE_STATE_VERSION,
      lastEventId: this.lastEventId,
      pendingOperations: this.pendingOperations.filter((op) => op.source !== "scan").map((op) => ({ ...op })),
      dirtyPaths: [],
      uploadedBlobHashes: Array.from(this.uploadedBlobHashes),
      headRevisionByPath: Object.fromEntries(this.headRevisionByPath.entries()),
      pushedMtimeByPath: Object.fromEntries(this.pushedMtime.entries()),
      initialSyncDone: this.initialSyncDone || undefined,
      isNewVault: this.isNewVault || undefined,
      bootstrapPending: this.bootstrapPending || undefined,
      bootstrapPolicy: this.bootstrapPolicy || undefined,
      bootstrapLocalPaths: this.bootstrapLocalPaths.size ? Array.from(this.bootstrapLocalPaths) : undefined
    };
  }

  beginBootstrap(policy: BootstrapPolicy, files: TFile[]) {
    this.bootstrapPending = true;
    this.bootstrapPolicy = policy;
    this.bootstrapLocalPaths.clear();
    this.rebuildTrackedFiles(files);
    for (const file of files) {
      this.bootstrapLocalPaths.add(file.path);
    }
  }

  completeBootstrap() {
    this.initialSyncDone = true;
    this.bootstrapPending = false;
    this.bootstrapPolicy = null;
    this.bootstrapLocalPaths.clear();
  }

  isBootstrapLocalPath(path: string) {
    const normalizedPath = normalizePath(path);
    return Boolean(normalizedPath && this.bootstrapLocalPaths.has(normalizedPath));
  }

  rebuildTrackedFiles(files: TFile[]) {
    this.trackedFilesByDirectory.clear();
    this.knownDirectoryMtime.clear();
    for (const file of files) {
      this.trackFilePath(file.path);
    }
  }

  trackFilePath(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const directoryPath = parentDirectoryPath(normalizedPath);
    const trackedFiles = this.trackedFilesByDirectory.get(directoryPath) || new Set<string>();
    trackedFiles.add(normalizedPath);
    this.trackedFilesByDirectory.set(directoryPath, trackedFiles);
  }

  untrackFilePath(path: string) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const directoryPath = parentDirectoryPath(normalizedPath);
    const trackedFiles = this.trackedFilesByDirectory.get(directoryPath);
    if (!trackedFiles) return;
    trackedFiles.delete(normalizedPath);
    if (!trackedFiles.size) {
      this.trackedFilesByDirectory.delete(directoryPath);
      this.knownDirectoryMtime.delete(directoryPath);
    }
  }

  renameTrackedFilePath(prevPath: string, nextPath: string) {
    this.untrackFilePath(prevPath);
    this.trackFilePath(nextPath);
  }

  adoptRemoteMergeBaseline(files: TFile[]) {
    this.pendingOperations = this.pendingOperations.filter((op) => op.source !== "scan");
    for (const file of files) {
      if (this.headRevisionByPath.has(file.path)) {
        this.pushedMtime.set(file.path, file.stat.mtime);
        continue;
      }

      enqueueUpsert(this.pendingOperations, file.path, file.stat.mtime, "scan");
    }
  }

  adoptRemoteWinsBaseline(files: TFile[]) {
    this.pendingOperations = this.pendingOperations.filter((op) => op.source !== "scan" && op.source !== "bootstrap");
    for (const file of files) {
      if (this.headRevisionByPath.has(file.path)) {
        this.pushedMtime.set(file.path, file.stat.mtime);
        continue;
      }

      if (!this.isBootstrapLocalPath(file.path)) {
        enqueueUpsert(this.pendingOperations, file.path, file.stat.mtime, "scan");
      }
    }
  }

  queueBootstrapLocalFiles(files: TFile[]) {
    this.pendingOperations = this.pendingOperations.filter((op) => op.source !== "scan" && op.source !== "bootstrap");
    for (const file of files) {
      const knownMtime = this.pushedMtime.get(file.path);
      if (this.isBootstrapLocalPath(file.path)) {
        if (knownMtime !== file.stat.mtime) {
          enqueueUpsert(this.pendingOperations, file.path, Date.now(), "bootstrap");
        }
        continue;
      }

      if (this.headRevisionByPath.has(file.path)) {
        this.pushedMtime.set(file.path, file.stat.mtime);
        continue;
      }

      enqueueUpsert(this.pendingOperations, file.path, file.stat.mtime, "scan");
    }
  }
}

function parentDirectoryPath(path: string) {
  const lastSlashIdx = path.lastIndexOf("/");
  return lastSlashIdx >= 0 ? path.slice(0, lastSlashIdx) : "";
}
