import { describe, expect, it, vi } from "vitest";
import { CURRENT_ENGINE_STATE_VERSION, migrateEngineStateSnapshot } from "../src/sync/engine/snapshot";

describe("engine state snapshot migration", () => {
  it("migrates legacy snapshots without a version", () => {
    const migrated = migrateEngineStateSnapshot({
      lastEventId: 12,
      dirtyPaths: ["Notes/Test.md"],
      uploadedBlobHashes: [],
      headRevisionByPath: {}
    });

    expect(migrated?.version).toBe(CURRENT_ENGINE_STATE_VERSION);
    expect(migrated?.dirtyPaths).toEqual(["Notes/Test.md"]);
  });

  it("warns but keeps parsing newer snapshots", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const migrated = migrateEngineStateSnapshot({
      version: CURRENT_ENGINE_STATE_VERSION + 1,
      lastEventId: 7,
      uploadedBlobHashes: [],
      headRevisionByPath: {}
    });

    expect(migrated?.version).toBe(CURRENT_ENGINE_STATE_VERSION);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });
});
