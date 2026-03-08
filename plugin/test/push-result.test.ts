import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { applyPushResult } from "../src/sync/engine/push";
import { SyncState } from "../src/sync/engine/state";
import type { PendingLocalOperation, PushRequestOperation } from "../src/sync/engine/types";

type FakeFile = TFile & { stat: { mtime: number }; data?: Uint8Array };

function makeFile(path: string, mtime: number) {
  const file = new TFile() as FakeFile;
  file.path = path;
  file.stat = { mtime };
  return file;
}

function createVault(files: FakeFile[] = []) {
  const byPath = new Map(files.map((file) => [file.path, file]));

  return {
    files: byPath,
    vault: {
      adapter: {
        readBinary: vi.fn(async () => new Uint8Array([1, 2, 3])),
        writeBinary: vi.fn(async () => {})
      },
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      rename: vi.fn(async (file: FakeFile, nextPath: string) => {
        byPath.delete(file.path);
        file.path = nextPath;
        byPath.set(nextPath, file);
      })
    }
  };
}

describe("applyPushResult", () => {
  it("tracks head revision and pushed mtime for applied upserts", async () => {
    const state = new SyncState();
    const file = makeFile("Notes/Test.md", 25);
    const { vault } = createVault([file]);
    const pending: PendingLocalOperation = {
      operationId: "lop_1",
      op: "upsert",
      path: "Notes/Test.md",
      clientTs: 10,
      source: "event"
    };
    state.pendingOperations.push(pending);

    const requestOp: PushRequestOperation = {
      operationId: "lop_1",
      op: "upsert",
      path: "Notes/Test.md",
      blobHash: "hash_1",
      size: 3,
      clientTs: 25
    };

    await applyPushResult({
      app: { vault } as never,
      state,
      ensureDirectory: async () => {},
      markRemoteSuppressedPath: () => {},
      debugPerf: () => {}
    }, pending, requestOp, {
      operationId: "lop_1",
      status: "applied",
      revisionId: "rev_1",
      headRevisionId: "rev_1"
    });

    expect(state.pendingOperations).toHaveLength(0);
    expect(state.headRevisionByPath.get("Notes/Test.md")).toBe("rev_1");
    expect(state.pushedMtime.get("Notes/Test.md")).toBe(25);
  });

  it("renames local file to conflict path and requeues it on push conflicts", async () => {
    const state = new SyncState();
    const file = makeFile("Notes/Test.md", 25);
    const { vault, files } = createVault([file]);
    const pending: PendingLocalOperation = {
      operationId: "lop_1",
      op: "upsert",
      path: "Notes/Test.md",
      clientTs: 10,
      source: "event"
    };
    state.pendingOperations.push(pending);

    const requestOp: PushRequestOperation = {
      operationId: "lop_1",
      op: "upsert",
      path: "Notes/Test.md",
      blobHash: "hash_1",
      size: 3,
      clientTs: 25
    };

    const markRemoteSuppressedPath = vi.fn();
    await applyPushResult({
      app: { vault } as never,
      state,
      ensureDirectory: async () => {},
      markRemoteSuppressedPath,
      debugPerf: () => {}
    }, pending, requestOp, {
      operationId: "lop_1",
      status: "conflict",
      headRevisionId: "rev_head",
      conflictPath: "Notes/Test (conflict local 2026-03-09).md"
    });

    expect(vault.rename).toHaveBeenCalledOnce();
    expect(markRemoteSuppressedPath).toHaveBeenNthCalledWith(1, "Notes/Test (conflict local 2026-03-09).md");
    expect(markRemoteSuppressedPath).toHaveBeenNthCalledWith(2, "Notes/Test.md");
    expect(state.pendingOperations).toEqual([
      expect.objectContaining({
        path: "Notes/Test (conflict local 2026-03-09).md",
        source: "event"
      })
    ]);
    expect(state.headRevisionByPath.get("Notes/Test.md")).toBe("rev_head");
    expect(files.has("Notes/Test (conflict local 2026-03-09).md")).toBe(true);
  });
});
