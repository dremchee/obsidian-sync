import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { encryptBytes, utf8Encode } from "../src/sync/crypto";
import { applyRemoteEvent } from "../src/sync/engine/remote";
import { SyncState } from "../src/sync/engine/state";
import type { PullEvent } from "../src/sync/engine/types";

type FakeFile = TFile & { stat: { mtime: number }; data?: Uint8Array };

function makeFile(path: string, mtime: number, data?: Uint8Array) {
  const file = new TFile() as FakeFile;
  file.path = path;
  file.stat = { mtime };
  file.data = data;
  return file;
}

function createVault(files: FakeFile[] = []) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  let nextMtime = 1_000;

  const adapter = {
    readBinary: vi.fn(async (path: string) => byPath.get(path)?.data ?? new Uint8Array()),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      const bytes = new Uint8Array(data);
      const existing = byPath.get(path) ?? makeFile(path, nextMtime, bytes);
      existing.path = path;
      existing.data = bytes;
      existing.stat = { mtime: nextMtime++ };
      byPath.set(path, existing);
    }),
    stat: vi.fn(async (path: string) => {
      const file = byPath.get(path);
      return file ? { mtime: file.stat.mtime } : null;
    })
  };

  return {
    files: byPath,
    vault: {
      adapter,
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      delete: vi.fn(async (file: FakeFile) => {
        byPath.delete(file.path);
      }),
      rename: vi.fn(async (file: FakeFile, nextPath: string) => {
        byPath.delete(file.path);
        file.path = nextPath;
        file.stat = { mtime: nextMtime++ };
        byPath.set(nextPath, file);
      })
    }
  };
}

async function makeEncryptedBlob(passphrase: string, text: string) {
  const payload = await encryptBytes(passphrase, utf8Encode(text));
  return utf8Encode(JSON.stringify(payload));
}

describe("applyRemoteEvent", () => {
  it("creates a conflict copy and rewrites the remote path on conflicting upsert", async () => {
    const existing = makeFile("Notes/Test.md", 10, utf8Encode("local version"));
    const { vault, files } = createVault([existing]);
    const state = new SyncState();
    state.pendingOperations.push({
      operationId: "lop_1",
      op: "upsert",
      path: "Notes/Test.md",
      clientTs: 10,
      source: "event"
    });

    const saveConflictCopy = vi.fn(async (_file: TFile, conflictPath: string) => {
      files.set(conflictPath, makeFile(conflictPath, 11, utf8Encode("local version")));
    });
    const markRemoteSuppressedPath = vi.fn();

    const evt: PullEvent = {
      eventId: 1,
      fileId: "file_1",
      revisionId: "rev_remote",
      deviceId: "device_remote",
      path: "Notes/Test.md",
      op: "upsert",
      blobHash: "hash_1",
      size: 12,
      revisionTs: 100
    };

    const result = await applyRemoteEvent({
      app: { vault } as never,
      settings: { passphrase: "secret", deviceId: "device_local" } as never,
      state,
      downloadBlob: async () => makeEncryptedBlob("secret", "remote version"),
      saveConflictCopy,
      ensureDirectory: async () => {},
      markRemoteSuppressedPath,
      debugPerf: () => {}
    }, evt);

    expect(result.wasConflict).toBe(true);
    expect(saveConflictCopy).toHaveBeenCalledOnce();
    expect(state.pendingOperations).toHaveLength(1);
    expect(state.pendingOperations[0]?.path).toContain("(conflict");
    expect(new TextDecoder().decode(files.get("Notes/Test.md")?.data)).toBe("remote version");
    expect(state.headRevisionByPath.get("Notes/Test.md")).toBe("rev_remote");
    expect(markRemoteSuppressedPath).toHaveBeenCalledWith("Notes/Test.md", expect.objectContaining({ expectedMtime: expect.any(Number) }));
  });

  it("preserves local content during bootstrap local_wins upsert", async () => {
    const existing = makeFile("Notes/Test.md", 10, utf8Encode("local version"));
    const { vault } = createVault([existing]);
    const state = new SyncState();
    state.beginBootstrap("local_wins", [existing]);

    const evt: PullEvent = {
      eventId: 1,
      fileId: "file_1",
      revisionId: "rev_remote",
      deviceId: "device_remote",
      path: "Notes/Test.md",
      op: "upsert",
      blobHash: "hash_1",
      size: 12,
      revisionTs: 100
    };

    const result = await applyRemoteEvent({
      app: { vault } as never,
      settings: { passphrase: "secret", deviceId: "device_local" } as never,
      state,
      downloadBlob: async () => makeEncryptedBlob("secret", "remote version"),
      saveConflictCopy: async () => {},
      ensureDirectory: async () => {},
      markRemoteSuppressedPath: () => {},
      debugPerf: () => {}
    }, evt);

    expect(result.wasConflict).toBe(false);
    expect(state.pendingOperations).toEqual([
      expect.objectContaining({
        path: "Notes/Test.md",
        source: "bootstrap"
      })
    ]);
    expect(state.headRevisionByPath.get("Notes/Test.md")).toBe("rev_remote");
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });
});
