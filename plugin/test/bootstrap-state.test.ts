import { describe, expect, it } from "vitest";
import { SyncState } from "../src/sync/engine/state";

function makeFile(path: string, mtime: number) {
  return {
    path,
    stat: { mtime }
  };
}

describe("sync bootstrap state", () => {
  it("merge baseline marks remote-known files and queues local-only files", () => {
    const state = new SyncState();
    state.headRevisionByPath.set("Notes/Remote.md", "rev_remote");

    state.adoptRemoteMergeBaseline([
      makeFile("Notes/Remote.md", 10),
      makeFile("Notes/LocalOnly.md", 20)
    ]);

    expect(state.pushedMtime.get("Notes/Remote.md")).toBe(10);
    expect(state.pendingOperations).toEqual([
      expect.objectContaining({
        op: "upsert",
        path: "Notes/LocalOnly.md",
        clientTs: 20,
        source: "scan"
      })
    ]);
  });

  it("remote_wins skips bootstrap-local files but still queues new files created during bootstrap", () => {
    const state = new SyncState();
    state.beginBootstrap("remote_wins", [
      makeFile("Notes/ExistingLocal.md", 10)
    ]);

    state.adoptRemoteWinsBaseline([
      makeFile("Notes/ExistingLocal.md", 10),
      makeFile("Notes/CreatedDuringBootstrap.md", 15)
    ]);

    expect(state.pendingOperations).toEqual([
      expect.objectContaining({
        path: "Notes/CreatedDuringBootstrap.md",
        clientTs: 15,
        source: "scan"
      })
    ]);
  });

  it("local_wins queues preserved bootstrap files and leaves remote-known files as baseline", () => {
    const state = new SyncState();
    state.beginBootstrap("local_wins", [
      makeFile("Notes/Preserve.md", 10)
    ]);
    state.pushedMtime.set("Notes/Preserve.md", 5);
    state.headRevisionByPath.set("Notes/Remote.md", "rev_remote");

    state.queueBootstrapLocalFiles([
      makeFile("Notes/Preserve.md", 10),
      makeFile("Notes/Remote.md", 25),
      makeFile("Notes/NewDuringBootstrap.md", 30)
    ]);

    expect(state.pendingOperations).toEqual([
      expect.objectContaining({
        path: "Notes/Preserve.md",
        source: "bootstrap"
      }),
      expect.objectContaining({
        path: "Notes/NewDuringBootstrap.md",
        clientTs: 30,
        source: "scan"
      })
    ]);
    expect(state.pushedMtime.get("Notes/Remote.md")).toBe(25);
  });
});
