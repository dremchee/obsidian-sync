import { TAbstractFile, TFile, type Vault } from "obsidian";
import type { PendingLocalOperation } from "./types";

export function prunePendingFileOperations(vault: Vault, pendingOperations: PendingLocalOperation[]) {
  return pendingOperations.filter((op) => {
    const pathNode = vault.getAbstractFileByPath(op.path);
    if (pathNode instanceof TAbstractFile && !(pathNode instanceof TFile)) {
      return false;
    }
    const prevNode = op.prevPath ? vault.getAbstractFileByPath(op.prevPath) : null;
    if (prevNode instanceof TAbstractFile && !(prevNode instanceof TFile)) {
      return false;
    }
    return true;
  });
}

export function pruneTrackedPaths(tracked: Map<string, unknown> | Set<string>, vault: Vault) {
  for (const path of Array.from(tracked.keys())) {
    const node = vault.getAbstractFileByPath(path);
    if (node instanceof TAbstractFile && !(node instanceof TFile)) {
      tracked.delete(path);
    }
  }
}
