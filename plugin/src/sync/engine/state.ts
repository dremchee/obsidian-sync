import type { TFile } from "obsidian";
import { normalizePendingOperation } from "./queue";
import type { EngineStateSnapshot, PendingLocalOperation } from "./types";
import { newOperationId, normalizePath } from "./utils";

export class SyncState {
  lastEventId = 0;
  readonly headRevisionByPath = new Map<string, string>();
  readonly pushedMtime = new Map<string, number>();
  readonly uploadedBlobHashes = new Set<string>();
  readonly remoteWriteSuppressUntil = new Map<string, number>();
  pendingOperations: PendingLocalOperation[] = [];
  initialSyncDone = false;
  isNewVault = false;
  lastPullAt = 0;
  scanCursor = 0;

  reset() {
    this.lastEventId = 0;
    this.headRevisionByPath.clear();
    this.pushedMtime.clear();
    this.uploadedBlobHashes.clear();
    this.remoteWriteSuppressUntil.clear();
    this.pendingOperations = [];
    this.initialSyncDone = false;
    this.isNewVault = false;
    this.lastPullAt = 0;
    this.scanCursor = 0;
  }

  applySnapshot(snapshot: Partial<EngineStateSnapshot> | null | undefined) {
    if (!snapshot || typeof snapshot !== "object") return;

    if (Number.isFinite(snapshot.lastEventId)) {
      this.lastEventId = Math.max(0, Number(snapshot.lastEventId));
    }

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
  }

  snapshot(): EngineStateSnapshot {
    return {
      lastEventId: this.lastEventId,
      pendingOperations: this.pendingOperations.filter((op) => op.source !== "scan").map((op) => ({ ...op })),
      dirtyPaths: [],
      uploadedBlobHashes: Array.from(this.uploadedBlobHashes),
      headRevisionByPath: Object.fromEntries(this.headRevisionByPath.entries()),
      pushedMtimeByPath: Object.fromEntries(this.pushedMtime.entries()),
      isNewVault: this.isNewVault || undefined
    };
  }

  adoptBaseline(files: TFile[]) {
    this.pendingOperations = this.pendingOperations.filter((op) => op.source !== "scan");
    for (const file of files) {
      this.pushedMtime.set(file.path, file.stat.mtime);
    }
  }
}

export function markRemoteSuppressedPath(remoteWriteSuppressUntil: Map<string, number>, path: string) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return;
  remoteWriteSuppressUntil.set(normalizedPath, Date.now() + 5000);
}

export function shouldSuppressLocalEvent(remoteWriteSuppressUntil: Map<string, number>, path: string) {
  const normalizedPath = normalizePath(path);
  const until = remoteWriteSuppressUntil.get(normalizedPath);
  if (!until) return false;
  if (Date.now() <= until) return true;
  remoteWriteSuppressUntil.delete(normalizedPath);
  return false;
}
