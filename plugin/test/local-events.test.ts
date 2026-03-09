import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import {
  markRemoteSuppressedPath,
  shouldQueueLocalUpsert,
  shouldSuppressLocalEvent,
  type RemoteWriteSuppression
} from "@/sync/engine/local-events";

function makeFile(path: string, mtime: number) {
  return Object.assign(Object.create(TFile.prototype), {
    path,
    stat: { mtime }
  }) as TFile;
}

describe("local event suppression", () => {
  it("suppresses a one-shot rename/delete echo", () => {
    const suppressed = new Map<string, RemoteWriteSuppression>();
    markRemoteSuppressedPath(suppressed, "Notes/Test.md");

    expect(shouldSuppressLocalEvent(suppressed, "Notes/Test.md")).toBe(true);
    expect(shouldSuppressLocalEvent(suppressed, "Notes/Test.md")).toBe(false);
  });

  it("suppresses a file upsert when expected mtime matches the remote write", () => {
    const suppressed = new Map<string, RemoteWriteSuppression>();
    const pushedMtime = new Map<string, number>();
    pushedMtime.set("Notes/Test.md", 42);
    markRemoteSuppressedPath(suppressed, "Notes/Test.md", { expectedMtime: 42 });

    expect(shouldQueueLocalUpsert(suppressed, pushedMtime, makeFile("Notes/Test.md", 42))).toBe(false);
    expect(suppressed.has("Notes/Test.md")).toBe(false);
  });

  it("allows a local file change when mtime differs from the remote write", () => {
    const suppressed = new Map<string, RemoteWriteSuppression>();
    const pushedMtime = new Map<string, number>();
    pushedMtime.set("Notes/Test.md", 42);
    markRemoteSuppressedPath(suppressed, "Notes/Test.md", { expectedMtime: 42 });

    expect(shouldQueueLocalUpsert(suppressed, pushedMtime, makeFile("Notes/Test.md", 43))).toBe(true);
    expect(suppressed.has("Notes/Test.md")).toBe(true);
  });
});
