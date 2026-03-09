import { describe, expect, it, vi } from "vitest";

vi.mock("#app/utils/db", () => ({
  getOrmDb: vi.fn()
}));

vi.mock("#app/utils/cas", () => ({
  listAllBlobs: vi.fn()
}));

vi.mock("#app/utils/paths", () => ({
  resolveDataPaths: () => ({
    backupsPath: "/tmp/backups"
  })
}));

vi.mock("#app/utils/metrics", () => ({
  collectMetricsSnapshot: vi.fn(async () => ({
    vaults: 0,
    devicesActive: 0,
    devicesRevoked: 0,
    filesLive: 0,
    filesDeleted: 0,
    fileRevisions: 0,
    syncEvents: 0,
    syncConflicts: 0,
    blobCount: 0,
    blobUploadBytesTotal: 0,
    blobDownloadBytesTotal: 0,
    blobBatchRequestsTotal: 0,
    blobBatchItemsTotal: 0,
    blobBatchDeferredTotal: 0,
    blobBatchMissingTotal: 0,
    processUptimeSeconds: 0
  }))
}));

import { resolveHealthStatus } from "../server/utils/health";

describe("health helpers", () => {
  it("returns fail when any check fails", () => {
    expect(resolveHealthStatus(["ok", "warn", "fail"])).toBe("fail");
  });

  it("returns degraded when checks only warn", () => {
    expect(resolveHealthStatus(["ok", "warn", "ok"])).toBe("degraded");
  });

  it("returns ok when all checks are healthy", () => {
    expect(resolveHealthStatus(["ok", "ok", "ok"])).toBe("ok");
  });
});
