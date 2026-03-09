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
