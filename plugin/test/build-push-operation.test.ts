import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { buildPushOperation } from "@/sync/engine/push";
import { SyncState } from "@/sync/engine/state";
import type { PendingLocalOperation } from "@/sync/engine/types";

function makeFile(path: string, mtime: number) {
  const file = new TFile();
  file.path = path;
  file.stat = { mtime };
  return file as TFile & { stat: { mtime: number } };
}

function makeContext(files: TFile[]) {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  return {
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null
      }
    }
  };
}

describe("buildPushOperation", () => {
  it("builds rename operations from tracked head revisions", async () => {
    const state = new SyncState();
    state.headRevisionByPath.set("Notes/Old.md", "rev_old");

    const pending: PendingLocalOperation = {
      operationId: "lop_1",
      op: "rename",
      path: "Notes/New.md",
      prevPath: "Notes/Old.md",
      clientTs: 10,
      source: "event"
    };

    const op = await buildPushOperation(
      { ...makeContext([]), state } as never,
      pending,
      new Map()
    );

    expect(op).toEqual({
      operationId: "lop_1",
      op: "rename",
      path: "Notes/New.md",
      prevPath: "Notes/Old.md",
      clientTs: 10,
      baseRevisionId: "rev_old"
    });
  });

  it("uses file mtime for regular upserts and original clientTs for bootstrap upserts", async () => {
    const regularState = new SyncState();
    regularState.headRevisionByPath.set("Notes/Test.md", "rev_old");
    const file = makeFile("Notes/Test.md", 42);
    const uploads = new Map([["lop_1", { hash: "h".repeat(64), bytes: new Uint8Array([1, 2, 3]) }]]);

    const regular = await buildPushOperation(
      { ...makeContext([file]), state: regularState } as never,
      {
        operationId: "lop_1",
        op: "upsert",
        path: "Notes/Test.md",
        clientTs: 10,
        source: "event"
      },
      uploads
    );

    const bootstrap = await buildPushOperation(
      { ...makeContext([file]), state: regularState } as never,
      {
        operationId: "lop_1",
        op: "upsert",
        path: "Notes/Test.md",
        clientTs: 10,
        source: "bootstrap"
      },
      uploads
    );

    expect(regular).toEqual(expect.objectContaining({
      op: "upsert",
      clientTs: 42,
      baseRevisionId: "rev_old"
    }));
    expect(bootstrap).toEqual(expect.objectContaining({
      op: "upsert",
      clientTs: 10,
      baseRevisionId: "rev_old"
    }));
  });

  it("falls back to delete when an upsert file is missing locally", async () => {
    const state = new SyncState();
    state.headRevisionByPath.set("Notes/Test.md", "rev_old");

    const op = await buildPushOperation(
      { ...makeContext([]), state } as never,
      {
        operationId: "lop_1",
        op: "upsert",
        path: "Notes/Test.md",
        clientTs: 10,
        source: "event"
      },
      new Map()
    );

    expect(op).toEqual({
      operationId: "lop_1",
      op: "delete",
      path: "Notes/Test.md",
      clientTs: 10,
      baseRevisionId: "rev_old"
    });
  });
});
