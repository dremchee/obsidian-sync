import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveDataPaths = vi.fn();

vi.mock("#app/utils/paths", () => ({
  resolveDataPaths: () => resolveDataPaths()
}));

import { blobPath, putBlobFromStream, sha256 } from "../server/utils/cas";

describe("cas streaming uploads", () => {
  let baseDir = "";

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "obsidian-sync-cas-"));
    resolveDataPaths.mockReturnValue({
      base: baseDir,
      dbPath: path.join(baseDir, "app.db"),
      blobsPath: path.join(baseDir, "blobs"),
      backupsPath: path.join(baseDir, "backups"),
      logsPath: path.join(baseDir, "logs")
    });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    resolveDataPaths.mockReset();
  });

  it("stores streamed blob content in CAS", async () => {
    const payload = Buffer.from("hello streamed blob");
    const hash = sha256(payload);

    const result = await putBlobFromStream(hash, Readable.from([payload]));

    expect(result.size).toBe(payload.length);
    expect(await readFile(blobPath(hash))).toEqual(payload);
  });

  it("rejects hash mismatches and removes temp files", async () => {
    const payload = Buffer.from("bad payload");
    const hash = "a".repeat(64);

    await expect(putBlobFromStream(hash, Readable.from([payload]))).rejects.toThrow(/Hash mismatch:/);
  });
});
