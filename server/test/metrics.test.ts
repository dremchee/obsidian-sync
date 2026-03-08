import { describe, expect, it, vi } from "vitest";

vi.mock("#app/utils/db", () => ({
  getOrmDb: vi.fn()
}));

vi.mock("#app/utils/cas", () => ({
  listAllBlobs: vi.fn()
}));

import { renderPrometheusMetrics } from "../server/utils/metrics";

describe("metrics rendering", () => {
  it("renders prometheus gauges", () => {
    const output = renderPrometheusMetrics({
      vaults: 1,
      devicesActive: 2,
      devicesRevoked: 3,
      filesLive: 4,
      filesDeleted: 5,
      fileRevisions: 6,
      syncEvents: 7,
      syncConflicts: 8,
      blobCount: 9,
      processUptimeSeconds: 10
    });

    expect(output).toContain("obsidian_sync_vaults_total 1");
    expect(output).toContain("obsidian_sync_devices_active 2");
    expect(output).toContain("obsidian_sync_files_live 4");
    expect(output).toContain("obsidian_sync_conflicts_total 8");
    expect(output).toContain("obsidian_sync_process_uptime_seconds 10");
  });
});
