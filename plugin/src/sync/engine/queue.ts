import type { TFile } from "obsidian";
import type { PendingLocalOperation } from "./types";
import { newOperationId, normalizePath } from "./utils";

function directoryPathFor(path: string) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return "";
  const lastSlashIdx = normalizedPath.lastIndexOf("/");
  return lastSlashIdx >= 0 ? normalizedPath.slice(0, lastSlashIdx) : "";
}

export function normalizePendingOperation(
  op: Partial<PendingLocalOperation> | null | undefined
): PendingLocalOperation | null {
  if (!op || typeof op !== "object") return null;
  const path = normalizePath(op.path);
  const kind = op.op;
  if (!path || (kind !== "upsert" && kind !== "delete" && kind !== "rename")) return null;
  const prevPath = normalizePath(op.prevPath);
  if (kind === "rename" && !prevPath) return null;
  return {
    operationId: typeof op.operationId === "string" && op.operationId ? op.operationId : newOperationId(),
    op: kind,
    path,
    prevPath: kind === "rename" ? prevPath : undefined,
    clientTs: Number.isFinite(op.clientTs) ? Math.max(0, Number(op.clientTs)) : Date.now(),
    source: op.source === "scan" || op.source === "bootstrap" ? op.source : "event"
  };
}

export function enqueueUpsert(
  pendingOperations: PendingLocalOperation[],
  path: string,
  clientTs?: number,
  source: "event" | "scan" | "bootstrap" = "event"
) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return;

  for (let i = pendingOperations.length - 1; i >= 0; i -= 1) {
    const op = pendingOperations[i];
    if (op.op === "upsert" && op.path === normalizedPath) {
      pendingOperations[i] = {
        ...op,
        clientTs: clientTs ?? Date.now(),
        source: source === "event" || op.source !== "event" ? source : op.source
      };
      return;
    }
    if (op.path === normalizedPath || op.prevPath === normalizedPath) break;
  }

  pendingOperations.push({
    operationId: newOperationId(),
    op: "upsert",
    path: normalizedPath,
    clientTs: clientTs ?? Date.now(),
    source
  });
}

export function enqueueDelete(pendingOperations: PendingLocalOperation[], path: string, clientTs?: number) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return;

  for (let i = pendingOperations.length - 1; i >= 0; i -= 1) {
    const op = pendingOperations[i];
    if (op.op === "upsert" && op.path === normalizedPath) {
      pendingOperations.splice(i, 1);
      continue;
    }
    if (op.op === "delete" && op.path === normalizedPath) {
      pendingOperations[i] = {
        ...op,
        clientTs: clientTs ?? Date.now(),
        source: "event"
      };
      return;
    }
    if (op.path === normalizedPath || op.prevPath === normalizedPath) break;
  }

  pendingOperations.push({
    operationId: newOperationId(),
    op: "delete",
    path: normalizedPath,
    clientTs: clientTs ?? Date.now(),
    source: "event"
  });
}

export function enqueueRename(
  pendingOperations: PendingLocalOperation[],
  prevPath: string,
  nextPath: string,
  clientTs?: number
) {
  const fromPath = normalizePath(prevPath);
  const toPath = normalizePath(nextPath);
  if (!fromPath || !toPath || fromPath === toPath) return;

  const movedUpserts: PendingLocalOperation[] = [];
  for (let i = pendingOperations.length - 1; i >= 0; i -= 1) {
    const op = pendingOperations[i];
    if (op.op === "upsert" && op.path === fromPath) {
      movedUpserts.unshift({ ...op, path: toPath });
      pendingOperations.splice(i, 1);
      continue;
    }
    break;
  }

  const last = pendingOperations[pendingOperations.length - 1];
  if (last?.op === "rename" && last.path === fromPath) {
    last.path = toPath;
    last.clientTs = clientTs ?? Date.now();
    last.source = "event";
  } else {
    pendingOperations.push({
      operationId: newOperationId(),
      op: "rename",
      path: toPath,
      prevPath: fromPath,
      clientTs: clientTs ?? Date.now(),
      source: "event"
    });
  }

  for (const op of movedUpserts) {
    op.clientTs = clientTs ?? op.clientTs;
    op.source = "event";
    pendingOperations.push(op);
  }
}

export function hasPendingOperationForPath(
  pendingOperations: PendingLocalOperation[],
  path: string,
  opts?: { includeScan?: boolean }
) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return false;
  const includeScan = opts?.includeScan ?? true;
  return pendingOperations.some((op) => {
    if (!includeScan && op.source === "scan") return false;
    return op.path === normalizedPath || op.prevPath === normalizedPath;
  });
}

export async function collectFallbackOperations(args: {
  pendingOperations: PendingLocalOperation[];
  files: TFile[];
  pushedMtime: Map<string, number>;
  trackedFilesByDirectory: Map<string, Set<string>>;
  knownDirectoryMtime: Map<string, number>;
  directoryScanCursor: number;
  fallbackScanChunkSize: number;
  statDirectory: (path: string) => Promise<{ mtime: number } | null>;
}) {
  const {
    pendingOperations,
    files,
    pushedMtime,
    trackedFilesByDirectory,
    knownDirectoryMtime,
    directoryScanCursor,
    fallbackScanChunkSize,
    statDirectory
  } = args;

  if (!trackedFilesByDirectory.size) {
    for (const file of files) {
      const directoryPath = directoryPathFor(file.path);
      const trackedFiles = trackedFilesByDirectory.get(directoryPath) || new Set<string>();
      trackedFiles.add(file.path);
      trackedFilesByDirectory.set(directoryPath, trackedFiles);
    }
  }

  const directories = Array.from(trackedFilesByDirectory.keys());
  if (!directories.length) {
    return { enqueued: 0, nextDirectoryScanCursor: directoryScanCursor };
  }

  const remaining = Math.min(fallbackScanChunkSize, directories.length);
  let enqueued = 0;
  for (let i = 0; i < remaining; i += 1) {
    const idx = (directoryScanCursor + i) % directories.length;
    const directoryPath = directories[idx];
    const currentDirectoryMtime = directoryPath ? (await statDirectory(directoryPath))?.mtime ?? 0 : -1;
    const knownDirectoryStatMtime = knownDirectoryMtime.get(directoryPath);
    if (directoryPath && knownDirectoryStatMtime === currentDirectoryMtime) {
      continue;
    }

    knownDirectoryMtime.set(directoryPath, currentDirectoryMtime);
    const currentDirectoryFiles = files.filter((file) => directoryPathFor(file.path) === directoryPath);
    trackedFilesByDirectory.set(directoryPath, new Set(currentDirectoryFiles.map((file) => file.path)));

    for (const file of currentDirectoryFiles) {
      if (hasPendingOperationForPath(pendingOperations, file.path)) continue;
      const knownMtime = pushedMtime.get(file.path);
      if (knownMtime === file.stat.mtime) continue;
      enqueueUpsert(pendingOperations, file.path, file.stat.mtime, "scan");
      enqueued += 1;
    }
  }

  return {
    enqueued,
    nextDirectoryScanCursor: (directoryScanCursor + remaining) % directories.length
  };
}

export function dropScanOperationsForPaths(
  pendingOperations: PendingLocalOperation[],
  paths: Array<string | null | undefined>
) {
  const normalized = new Set(paths.map((path) => normalizePath(path)).filter(Boolean));
  if (!normalized.size) return pendingOperations;
  return pendingOperations.filter((op) => {
    if (op.source !== "scan") return true;
    return !normalized.has(op.path) && !normalized.has(op.prevPath || "");
  });
}
