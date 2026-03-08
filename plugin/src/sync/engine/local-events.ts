import { TAbstractFile, TFile } from "obsidian";
import { normalizePath } from "./utils";

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

export function shouldQueueLocalUpsert(
  remoteWriteSuppressUntil: Map<string, number>,
  pushedMtime: Map<string, number>,
  file?: TAbstractFile | null
): boolean {
  if (!file?.path) return false;
  if (shouldSuppressLocalEvent(remoteWriteSuppressUntil, file.path)) {
    return false;
  }
  if (!(file instanceof TFile)) {
    return true;
  }
  const knownMtime = pushedMtime.get(file.path);
  if (knownMtime !== undefined && file.stat.mtime <= knownMtime) {
    return false;
  }
  return true;
}
