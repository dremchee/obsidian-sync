import { TFile, type App } from "obsidian";
import type { SyncSettings } from "../../settings";
import { decryptBytes, utf8Decode } from "../crypto";
import { makeConflictPath } from "../conflicts";
import { dropScanOperationsForPaths, enqueueUpsert, hasPendingOperationForPath } from "./queue";
import type { SyncState } from "./state";
import type { PendingLocalOperation, PullEvent } from "./types";
import { normalizePath } from "./utils";

export type RemoteContext = {
  app: App;
  settings: SyncSettings;
  state: SyncState;
  downloadBlob: (hash: string) => Promise<Uint8Array>;
  saveConflictCopy: (file: TFile, conflictPath: string) => Promise<void>;
  ensureDirectory: (dirPath: string) => Promise<void>;
  markRemoteSuppressedPath: (path: string) => void;
  debugPerf: (message: string) => void;
};

export async function applyRemoteEvent(
  ctx: RemoteContext,
  evt: PullEvent,
  prefetchedBlobs?: Map<string, Uint8Array>
) {
  if (evt.op === "delete") {
    return applyRemoteDelete(ctx, evt);
  }
  if (evt.op === "rename") {
    return applyRemoteRename(ctx, evt);
  }
  return applyRemoteUpsert(ctx, evt, prefetchedBlobs);
}

function dropStaleEventUpsertsForPaths(
  app: App,
  pendingOperations: PendingLocalOperation[],
  pushedMtime: Map<string, number>,
  paths: Array<string | null | undefined>
) {
  const normalizedPaths = new Set(paths.map((path) => normalizePath(path)).filter(Boolean));
  if (!normalizedPaths.size) return pendingOperations;

  return pendingOperations.filter((op) => {
    if (op.source !== "event" || op.op !== "upsert" || !normalizedPaths.has(op.path)) {
      return true;
    }
    const file = app.vault.getAbstractFileByPath(op.path);
    if (!(file instanceof TFile)) {
      return false;
    }
    const knownMtime = pushedMtime.get(op.path);
    if (knownMtime === undefined) {
      return true;
    }
    return file.stat.mtime !== knownMtime;
  });
}

function requeueConflictPath(
  pendingOperations: PendingLocalOperation[],
  pushedMtime: Map<string, number>,
  sourcePath: string,
  conflictPath: string
) {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedConflict = normalizePath(conflictPath);
  const nextPendingOperations = pendingOperations.filter(
    (op) => op.path !== normalizedSource && op.prevPath !== normalizedSource
  );
  enqueueUpsert(nextPendingOperations, normalizedConflict);
  pushedMtime.delete(normalizedSource);
  return nextPendingOperations;
}

async function applyRemoteDelete(ctx: RemoteContext, evt: PullEvent) {
  let wasConflict = false;
  ctx.state.pendingOperations = dropScanOperationsForPaths(ctx.state.pendingOperations, [evt.path]);
  ctx.state.pendingOperations = dropStaleEventUpsertsForPaths(
    ctx.app,
    ctx.state.pendingOperations,
    ctx.state.pushedMtime,
    [evt.path]
  );
  if (hasPendingOperationForPath(ctx.state.pendingOperations, evt.path, { includeScan: false })) {
    const f = ctx.app.vault.getAbstractFileByPath(evt.path);
    if (f instanceof TFile) {
      const conflictPath = makeConflictPath(evt.path, ctx.settings.deviceId || "local", Date.now());
      await ctx.saveConflictCopy(f, conflictPath);
      ctx.debugPerf(`conflict on delete: saved ${evt.path} -> ${conflictPath}`);
      ctx.state.pendingOperations = requeueConflictPath(ctx.state.pendingOperations, ctx.state.pushedMtime, evt.path, conflictPath);
      wasConflict = true;
    }
  }

  ctx.markRemoteSuppressedPath(evt.path);
  const f = ctx.app.vault.getAbstractFileByPath(evt.path);
  if (f instanceof TFile) {
    await ctx.app.vault.delete(f);
  }
  if (evt.revisionId) {
    ctx.state.headRevisionByPath.set(evt.path, evt.revisionId);
  }
  ctx.state.pushedMtime.delete(evt.path);
  return { pendingOperations: ctx.state.pendingOperations, wasConflict };
}

async function applyRemoteRename(ctx: RemoteContext, evt: PullEvent) {
  const prevPath = normalizePath(evt.prevPath);
  if (!prevPath || prevPath === evt.path) {
    return { pendingOperations: ctx.state.pendingOperations, wasConflict: false };
  }

  let wasConflict = false;
  ctx.state.pendingOperations = dropScanOperationsForPaths(ctx.state.pendingOperations, [prevPath, evt.path]);
  ctx.state.pendingOperations = dropStaleEventUpsertsForPaths(
    ctx.app,
    ctx.state.pendingOperations,
    ctx.state.pushedMtime,
    [prevPath, evt.path]
  );
  if (
    hasPendingOperationForPath(ctx.state.pendingOperations, prevPath, { includeScan: false }) ||
    hasPendingOperationForPath(ctx.state.pendingOperations, evt.path, { includeScan: false })
  ) {
    const source = ctx.app.vault.getAbstractFileByPath(prevPath);
    const target = ctx.app.vault.getAbstractFileByPath(evt.path);
    const conflictSource = source instanceof TFile ? source : target instanceof TFile ? target : null;
    if (conflictSource) {
      const conflictPath = makeConflictPath(conflictSource.path, ctx.settings.deviceId || "local", Date.now());
      await ctx.saveConflictCopy(conflictSource, conflictPath);
      ctx.debugPerf(`conflict on rename: saved ${conflictSource.path} -> ${conflictPath}`);
      ctx.state.pendingOperations = requeueConflictPath(ctx.state.pendingOperations, ctx.state.pushedMtime, conflictSource.path, conflictPath);
      wasConflict = true;
    }
  }

  const source = ctx.app.vault.getAbstractFileByPath(prevPath);
  const target = ctx.app.vault.getAbstractFileByPath(evt.path);
  ctx.markRemoteSuppressedPath(prevPath);
  ctx.markRemoteSuppressedPath(evt.path);
  const parentDir = evt.path.substring(0, evt.path.lastIndexOf("/"));
  if (parentDir) {
    await ctx.ensureDirectory(parentDir);
  }

  if (source instanceof TFile) {
    if (target instanceof TFile && target.path !== source.path) {
      await ctx.app.vault.delete(target);
    }
    await ctx.app.vault.rename(source, evt.path);
    const stat = await ctx.app.vault.adapter.stat(evt.path);
    if (stat) {
      ctx.state.pushedMtime.set(evt.path, stat.mtime);
    }
  }

  ctx.state.headRevisionByPath.delete(prevPath);
  if (evt.revisionId) {
    ctx.state.headRevisionByPath.set(evt.path, evt.revisionId);
  }
  ctx.state.pushedMtime.delete(prevPath);
  return { pendingOperations: ctx.state.pendingOperations, wasConflict };
}

async function applyRemoteUpsert(
  ctx: RemoteContext,
  evt: PullEvent,
  prefetchedBlobs?: Map<string, Uint8Array>
) {
  if (!evt.blobHash) {
    return { pendingOperations: ctx.state.pendingOperations, wasConflict: false };
  }

  ctx.state.pendingOperations = dropScanOperationsForPaths(ctx.state.pendingOperations, [evt.path]);
  ctx.state.pendingOperations = dropStaleEventUpsertsForPaths(
    ctx.app,
    ctx.state.pendingOperations,
    ctx.state.pushedMtime,
    [evt.path]
  );
  const raw = prefetchedBlobs?.get(evt.blobHash) || await ctx.downloadBlob(evt.blobHash);
  let envelope: { salt: string; iv: string; ciphertext: string };
  try {
    envelope = JSON.parse(new TextDecoder().decode(raw)) as { salt: string; iv: string; ciphertext: string };
  } catch {
    throw new Error("CRYPTO_PAYLOAD_INVALID: blob is not valid JSON envelope");
  }
  const plain = await decryptBytes(ctx.settings.passphrase, envelope);

  const text = utf8Decode(plain);
  const existing = ctx.app.vault.getAbstractFileByPath(evt.path);
  let wasConflict = false;

  if (existing instanceof TFile) {
    const currentText = await ctx.app.vault.cachedRead(existing);
    if (currentText === text) {
      ctx.state.pendingOperations = dropStaleEventUpsertsForPaths(
        ctx.app,
        ctx.state.pendingOperations,
        ctx.state.pushedMtime,
        [evt.path]
      );
      ctx.state.pushedMtime.set(existing.path, existing.stat.mtime);
      return { pendingOperations: ctx.state.pendingOperations, wasConflict: false };
    }

    if (hasPendingOperationForPath(ctx.state.pendingOperations, evt.path, { includeScan: false })) {
      const conflictPath = makeConflictPath(evt.path, ctx.settings.deviceId || "local", Date.now());
      await ctx.saveConflictCopy(existing, conflictPath);
      ctx.debugPerf(`conflict on pull: saved ${evt.path} -> ${conflictPath}`);
      ctx.state.pendingOperations = requeueConflictPath(ctx.state.pendingOperations, ctx.state.pushedMtime, evt.path, conflictPath);
      wasConflict = true;
    } else {
      ctx.debugPerf(`lww overwrite path=${evt.path} remoteTs=${evt.revisionTs} localMtime=${existing.stat.mtime}`);
    }
  }

  ctx.markRemoteSuppressedPath(evt.path);
  const parentDir = evt.path.substring(0, evt.path.lastIndexOf("/"));
  if (parentDir) {
    await ctx.ensureDirectory(parentDir);
  }
  await ctx.app.vault.adapter.write(evt.path, text);

  const stat = await ctx.app.vault.adapter.stat(evt.path);
  if (stat) {
    ctx.state.pushedMtime.set(evt.path, stat.mtime);
  }
  if (evt.revisionId) {
    ctx.state.headRevisionByPath.set(evt.path, evt.revisionId);
  }

  return { pendingOperations: ctx.state.pendingOperations, wasConflict };
}
