import { describe, expect, it, vi } from "vitest";

vi.mock("nitropack/runtime", () => ({
  useRuntimeConfig: () => ({})
}));

vi.mock("#app/utils/paths", () => ({
  resolveDataPaths: () => ({
    dbPath: "/tmp/app.db",
    blobsPath: "/tmp/blobs",
    backupsPath: "/tmp/backups"
  })
}));

import { formatBackupStamp, pruneExpiredBackups } from "../server/utils/backup";

describe("backup helpers", () => {
  it("formats backup directory stamps deterministically", () => {
    expect(formatBackupStamp(new Date("2026-03-09T12:34:56.789Z"))).toBe("20260309-123456");
  });

  it("selects only expired backup directories for pruning", () => {
    const nowMs = Date.parse("2026-03-09T12:00:00.000Z");
    const expired = pruneExpiredBackups([
      {
        name: "20260301-020000",
        isDirectory: true,
        mtimeMs: Date.parse("2026-03-01T02:00:00.000Z")
      },
      {
        name: "20260308-020000",
        isDirectory: true,
        mtimeMs: Date.parse("2026-03-08T02:00:00.000Z")
      },
      {
        name: "metadata.json",
        isDirectory: false,
        mtimeMs: Date.parse("2026-03-01T02:00:00.000Z")
      }
    ], nowMs, 7);

    expect(expired.map((entry) => entry.name)).toEqual(["20260301-020000"]);
  });
});
