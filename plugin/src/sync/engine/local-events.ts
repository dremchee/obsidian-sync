import { TAbstractFile, TFile } from "obsidian";
import { SYNC_TIMERS } from "../constants";
import { normalizePath } from "./utils";

export type RemoteWriteSuppression = {
  expectedMtime?: number;
  remainingPathEvents: number;
  expiresAt: number;
};

function getActiveSuppression(
  remoteWriteSuppressUntil: Map<string, RemoteWriteSuppression>,
  path: string
) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return null;
  const suppression = remoteWriteSuppressUntil.get(normalizedPath);
  if (!suppression) return null;
  if (Date.now() <= suppression.expiresAt) {
    return { normalizedPath, suppression };
  }
  remoteWriteSuppressUntil.delete(normalizedPath);
  return null;
}

export function markRemoteSuppressedPath(
  remoteWriteSuppressUntil: Map<string, RemoteWriteSuppression>,
  path: string,
  opts?: { expectedMtime?: number; remainingPathEvents?: number }
) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return;
  remoteWriteSuppressUntil.set(normalizedPath, {
    expectedMtime: opts?.expectedMtime,
    remainingPathEvents: Math.max(0, opts?.remainingPathEvents ?? 1),
    expiresAt: Date.now() + SYNC_TIMERS.remoteEventSuppressionTtlMs
  });
}

export function shouldSuppressLocalEvent(
  remoteWriteSuppressUntil: Map<string, RemoteWriteSuppression>,
  path: string
) {
  const active = getActiveSuppression(remoteWriteSuppressUntil, path);
  if (!active) return false;
  if (active.suppression.remainingPathEvents <= 1) {
    remoteWriteSuppressUntil.delete(active.normalizedPath);
  } else {
    active.suppression.remainingPathEvents -= 1;
  }
  return true;
}

export function shouldQueueLocalUpsert(
  remoteWriteSuppressUntil: Map<string, RemoteWriteSuppression>,
  pushedMtime: Map<string, number>,
  file?: TAbstractFile | null
): boolean {
  if (!file?.path) return false;
  if (!(file instanceof TFile)) {
    return !shouldSuppressLocalEvent(remoteWriteSuppressUntil, file.path);
  }
  const knownMtime = pushedMtime.get(file.path);
  if (knownMtime !== undefined && file.stat.mtime <= knownMtime) {
    const active = getActiveSuppression(remoteWriteSuppressUntil, file.path);
    if (active?.suppression.expectedMtime === file.stat.mtime) {
      remoteWriteSuppressUntil.delete(active.normalizedPath);
    }
    return false;
  }
  const active = getActiveSuppression(remoteWriteSuppressUntil, file.path);
  if (active?.suppression.expectedMtime === file.stat.mtime) {
    remoteWriteSuppressUntil.delete(active.normalizedPath);
    return false;
  }
  return true;
}
