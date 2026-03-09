import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  collectFallbackOperations,
  enqueueDelete,
  enqueueRename,
  enqueueUpsert,
  hasPendingOperationForPath
} from "../src/sync/engine/queue";
import type { PendingLocalOperation } from "../src/sync/engine/types";

function makeFile(path: string, mtime: number) {
  const file = new TFile();
  file.path = path;
  file.stat = { mtime };
  return file as TFile & { stat: { mtime: number } };
}

describe("queue operations", () => {
  it("collapses repeated upserts for the same path", () => {
    const pending: PendingLocalOperation[] = [];

    enqueueUpsert(pending, "Notes/Test.md", 10, "event");
    enqueueUpsert(pending, "Notes/Test.md", 20, "scan");

    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(expect.objectContaining({
      op: "upsert",
      path: "Notes/Test.md",
      clientTs: 20,
      source: "event"
    }));
  });

  it("turns an upsert into delete when the file is removed", () => {
    const pending: PendingLocalOperation[] = [];

    enqueueUpsert(pending, "Notes/Test.md", 10, "event");
    enqueueDelete(pending, "Notes/Test.md", 20);

    expect(pending).toEqual([
      expect.objectContaining({
        op: "delete",
        path: "Notes/Test.md",
        clientTs: 20
      })
    ]);
  });

  it("moves trailing upserts along with a rename", () => {
    const pending: PendingLocalOperation[] = [];

    enqueueUpsert(pending, "Notes/Old.md", 10, "event");
    enqueueRename(pending, "Notes/Old.md", "Notes/New.md", 20);

    expect(pending).toEqual([
      expect.objectContaining({
        op: "rename",
        prevPath: "Notes/Old.md",
        path: "Notes/New.md",
        clientTs: 20
      }),
      expect.objectContaining({
        op: "upsert",
        path: "Notes/New.md",
        source: "event"
      })
    ]);
  });

  it("collects fallback scan operations incrementally by directory", async () => {
    const pending: PendingLocalOperation[] = [];
    const files = [
      makeFile("Notes/A.md", 10),
      makeFile("Notes/B.md", 20),
      makeFile("Notes/C.md", 30)
    ];
    const pushedMtime = new Map<string, number>([["Notes/A.md", 10]]);
    const trackedFilesByDirectory = new Map<string, Set<string>>([
      ["Notes", new Set(["Notes/A.md", "Notes/B.md", "Notes/C.md"])]
    ]);
    const knownDirectoryMtime = new Map<string, number>();

    const first = await collectFallbackOperations({
      pendingOperations: pending,
      files,
      pushedMtime,
      trackedFilesByDirectory,
      knownDirectoryMtime,
      directoryScanCursor: 0,
      fallbackScanChunkSize: 1,
      statDirectory: async () => ({ mtime: 42 })
    });

    expect(first).toEqual({ enqueued: 2, nextDirectoryScanCursor: 0 });
    expect(pending.map((op) => op.path)).toEqual(["Notes/B.md", "Notes/C.md"]);
    expect(hasPendingOperationForPath(pending, "Notes/B.md")).toBe(true);
  });
});
