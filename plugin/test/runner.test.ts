import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { SYNC_DEFAULT_RUN_PROFILE } from "@/sync/constants";
import { SyncRunner } from "@/sync/engine/runner";
import { SyncState } from "@/sync/engine/state";
import type { PullEvent, PushRequestOperation, PushResult } from "@/sync/engine/types";

type FakeFile = TFile & { stat: { mtime: number } };

function makeFile(path: string, mtime: number) {
  const file = new TFile() as FakeFile;
  file.path = path;
  file.stat = { mtime };
  return file;
}

function createHarness(args: {
  bootstrapPolicy: "merge" | "remote_wins" | "local_wins";
  files: FakeFile[];
  pullEvents?: PullEvent[];
}) {
  const state = new SyncState();
  const filesByPath = new Map(args.files.map((file) => [file.path, file]));
  const requestJson = vi.fn(async (path: string, init?: { body?: { operations?: PushRequestOperation[] } }) => {
    if (path === "/api/v1/sync/pull") {
      return {
        events: args.pullEvents || [],
        nextAfterEventId: args.pullEvents?.length ? args.pullEvents.length : 0
      };
    }
    if (path === "/api/v1/sync/push") {
      return {
        results: (init?.body?.operations || []).map((op): PushResult => ({
          operationId: op.operationId,
          status: "applied",
          revisionId: `rev_${op.operationId}`,
          headRevisionId: `rev_${op.operationId}`
        }))
      };
    }
    throw new Error(`unexpected request path: ${path}`);
  });

  const client = {
    requestJson,
    downloadBlob: vi.fn(async () => new Uint8Array()),
    downloadBlobsBatched: vi.fn(async () => new Map()),
    filterMissingBlobs: vi.fn(async (items) => items),
    uploadBlob: vi.fn(async () => {}),
    authHeaders: vi.fn(() => ({}))
  };

  const deps = {
    app: {
      vault: {
        getFiles: () => args.files,
        getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null
      }
    },
    settings: {
      apiKey: "api_key",
      passphrase: "secret",
      bootstrapPolicy: args.bootstrapPolicy,
      intervalSec: 0,
      maxConcurrentUploads: 2,
      pullBatchSize: 100,
      deviceId: "device_local",
      debugPerfLogs: false
    },
    state,
    client,
    defaultRunProfile: SYNC_DEFAULT_RUN_PROFILE,
    debugPerf: vi.fn(),
    ensureDirectory: vi.fn(async () => {}),
    markRemoteSuppressedPath: vi.fn(),
    saveConflictCopy: vi.fn(async () => {}),
    isRecoverablePayloadError: vi.fn(() => false),
    readAndEncryptFile: vi.fn(async () => ({ hash: "h".repeat(64), bytes: new Uint8Array([1, 2, 3]) })),
    runWithConcurrency: async <T>(items: T[], _concurrency: number, worker: (item: T, index: number) => Promise<void>) => {
      for (const [index, item] of items.entries()) {
        await worker(item, index);
      }
    },
    yieldToUi: vi.fn(async () => {})
  };

  return {
    state,
    client,
    deps,
    runner: new SyncRunner(deps as never)
  };
}

describe("SyncRunner bootstrap orchestration", () => {
  it("completes remote_wins bootstrap without issuing a push", async () => {
    const remoteKnown = makeFile("Notes/Remote.md", 10);
    const harness = createHarness({
      bootstrapPolicy: "remote_wins",
      files: [remoteKnown]
    });
    harness.state.headRevisionByPath.set("Notes/Remote.md", "rev_remote");

    await harness.runner.runOnce();

    expect(harness.state.initialSyncDone).toBe(true);
    expect(harness.state.bootstrapPending).toBe(false);
    expect(harness.state.pushedMtime.get("Notes/Remote.md")).toBe(10);
    expect(harness.client.requestJson).toHaveBeenCalledTimes(1);
    expect(harness.client.requestJson).toHaveBeenCalledWith(
      "/api/v1/sync/pull",
      expect.any(Object)
    );
  });

  it("runs merge bootstrap as pull followed by push of local-only files", async () => {
    const remoteKnown = makeFile("Notes/Remote.md", 10);
    const localOnly = makeFile("Notes/LocalOnly.md", 20);
    const harness = createHarness({
      bootstrapPolicy: "merge",
      files: [remoteKnown, localOnly]
    });
    harness.state.headRevisionByPath.set("Notes/Remote.md", "rev_remote");

    await harness.runner.runOnce();

    expect(harness.state.initialSyncDone).toBe(true);
    expect(harness.client.requestJson).toHaveBeenCalledTimes(2);
    expect(harness.client.requestJson).toHaveBeenNthCalledWith(1, "/api/v1/sync/pull", expect.any(Object));
    expect(harness.client.requestJson).toHaveBeenNthCalledWith(2, "/api/v1/sync/push", expect.any(Object));
    expect(harness.state.headRevisionByPath.get("Notes/LocalOnly.md")).toMatch(/^rev_lop_/);
    expect(harness.state.pushedMtime.get("Notes/Remote.md")).toBe(10);
    expect(harness.state.pushedMtime.get("Notes/LocalOnly.md")).toBe(20);
  });

  it("runs local_wins bootstrap as pull followed by push of preserved local files", async () => {
    const preserved = makeFile("Notes/Preserve.md", 30);
    const harness = createHarness({
      bootstrapPolicy: "local_wins",
      files: [preserved],
      pullEvents: [{
        eventId: 1,
        fileId: "file_1",
        revisionId: "rev_remote",
        deviceId: "device_remote",
        path: "Notes/Preserve.md",
        op: "upsert",
        blobHash: "hash_1",
        size: 12,
        revisionTs: 100
      }]
    });

    const encryptedRemote = new Uint8Array([123, 125]);
    harness.client.downloadBlobsBatched.mockResolvedValue(new Map([["hash_1", encryptedRemote]]));
    harness.deps.isRecoverablePayloadError = vi.fn(() => true);

    await harness.runner.runOnce();

    expect(harness.state.initialSyncDone).toBe(true);
    expect(harness.client.requestJson).toHaveBeenCalledTimes(2);
    expect(harness.client.requestJson).toHaveBeenNthCalledWith(1, "/api/v1/sync/pull", expect.any(Object));
    expect(harness.client.requestJson).toHaveBeenNthCalledWith(2, "/api/v1/sync/push", expect.any(Object));
    expect(harness.state.headRevisionByPath.get("Notes/Preserve.md")).toMatch(/^rev_lop_/);
    expect(harness.state.pushedMtime.get("Notes/Preserve.md")).toBe(30);
  });
});
