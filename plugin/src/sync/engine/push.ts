import { TFile, type App } from "obsidian";
import { enqueueUpsert } from "./queue";
import type { SyncState } from "./state";
import type { PendingLocalOperation, PushRequestOperation, PushResult } from "./types";
import { normalizePath, toUint8Array } from "./utils";

export type PushContext = {
  app: App;
  state: SyncState;
  ensureDirectory: (dirPath: string) => Promise<void>;
  markRemoteSuppressedPath: (path: string) => void;
  debugPerf: (message: string) => void;
};

export async function buildPushOperation(
  ctx: Pick<PushContext, "app" | "state">,
  pending: PendingLocalOperation,
  uploadsByOperationId: Map<string, { hash: string; bytes: Uint8Array }>
): Promise<PushRequestOperation | null> {
  const clientTs = pending.clientTs || Date.now();
  if (pending.op === "rename") {
    const prevPath = normalizePath(pending.prevPath);
    if (!prevPath) return null;
    return {
      operationId: pending.operationId,
      op: "rename",
      path: pending.path,
      prevPath,
      clientTs,
      baseRevisionId: ctx.state.headRevisionByPath.get(prevPath)
    };
  }

  if (pending.op === "delete") {
    return {
      operationId: pending.operationId,
      op: "delete",
      path: pending.path,
      clientTs,
      baseRevisionId: ctx.state.headRevisionByPath.get(pending.path)
    };
  }

  const file = ctx.app.vault.getAbstractFileByPath(pending.path);
  if (!(file instanceof TFile)) {
    return {
      operationId: pending.operationId,
      op: "delete",
      path: pending.path,
      clientTs,
      baseRevisionId: ctx.state.headRevisionByPath.get(pending.path)
    };
  }

  const payload = uploadsByOperationId.get(pending.operationId);
  if (!payload) {
    throw new Error(`missing encrypted payload for ${pending.path}`);
  }

  return {
    operationId: pending.operationId,
    op: "upsert",
    path: pending.path,
    blobHash: payload.hash,
    size: payload.bytes.length,
    clientTs: pending.source === "bootstrap" ? clientTs : file.stat.mtime || clientTs,
    baseRevisionId: ctx.state.headRevisionByPath.get(pending.path)
  };
}

export async function applyPushResult(
  ctx: PushContext,
  pending: PendingLocalOperation,
  requestOp: PushRequestOperation,
  result: PushResult
) {
  ctx.state.pendingOperations = ctx.state.pendingOperations.filter((op) => op.operationId !== pending.operationId);

  if (result.status === "conflict" && result.conflictPath) {
    await handlePushConflict(ctx, pending, result.conflictPath, result.headRevisionId);
    return ctx.state.pendingOperations;
  }

  const head = result.headRevisionId || result.revisionId;
  if (requestOp.op === "rename") {
    if (requestOp.prevPath) {
      ctx.state.headRevisionByPath.delete(requestOp.prevPath);
    }
    if (head) {
      ctx.state.headRevisionByPath.set(requestOp.path, head);
    }
    const renamedFile = ctx.app.vault.getAbstractFileByPath(requestOp.path);
    if (renamedFile instanceof TFile) {
      ctx.state.pushedMtime.set(requestOp.path, renamedFile.stat.mtime);
    }
    return ctx.state.pendingOperations;
  }

  if (head) {
    ctx.state.headRevisionByPath.set(requestOp.path, head);
  }
  if (requestOp.op === "upsert") {
    const file = ctx.app.vault.getAbstractFileByPath(requestOp.path);
    if (file instanceof TFile) {
      ctx.state.pushedMtime.set(requestOp.path, file.stat.mtime);
    }
  }

  return ctx.state.pendingOperations;
}

async function handlePushConflict(
  ctx: PushContext,
  pending: PendingLocalOperation,
  conflictPath: string,
  headRevisionId?: string
) {
  const sourcePath = pending.op === "rename" ? pending.prevPath || pending.path : pending.path;
  const file = ctx.app.vault.getAbstractFileByPath(sourcePath);
  if (file instanceof TFile) {
    ctx.markRemoteSuppressedPath(conflictPath);
    ctx.markRemoteSuppressedPath(sourcePath);

    try {
      const parentDir = conflictPath.substring(0, conflictPath.lastIndexOf("/"));
      if (parentDir) {
        await ctx.ensureDirectory(parentDir);
      }
      await ctx.app.vault.rename(file, conflictPath);
      ctx.debugPerf(`conflict: renamed ${sourcePath} -> ${conflictPath}`);
    } catch {
      try {
        const content = toUint8Array(await ctx.app.vault.adapter.readBinary(file.path));
        await ctx.app.vault.adapter.writeBinary(conflictPath, content);
        ctx.debugPerf(`conflict: copied ${sourcePath} -> ${conflictPath}`);
      } catch (copyErr) {
        console.error(`[custom-sync] failed to create conflict copy: ${copyErr}`);
        return;
      }
    }

    enqueueUpsert(ctx.state.pendingOperations, conflictPath);
    ctx.state.pushedMtime.delete(sourcePath);
  }

  if (pending.op === "rename" && pending.prevPath) {
    if (headRevisionId) {
      ctx.state.headRevisionByPath.set(pending.prevPath, headRevisionId);
    }
    ctx.state.headRevisionByPath.delete(pending.path);
    return;
  }

  if (headRevisionId) {
    ctx.state.headRevisionByPath.set(pending.path, headRevisionId);
  }
}
