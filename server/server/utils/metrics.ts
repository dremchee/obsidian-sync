import { sql } from "drizzle-orm";
import { getOrmDb } from "#app/utils/db";
import { listAllBlobs } from "#app/utils/cas";

export type MetricsSnapshot = {
  vaults: number;
  devicesActive: number;
  devicesRevoked: number;
  filesLive: number;
  filesDeleted: number;
  fileRevisions: number;
  syncEvents: number;
  syncConflicts: number;
  blobCount: number;
  processUptimeSeconds: number;
};

function getCount(query: ReturnType<typeof sql>) {
  const db = getOrmDb();
  const row = db.get<{ value: number }>(query);
  return Number(row?.value || 0);
}

export async function collectMetricsSnapshot(): Promise<MetricsSnapshot> {
  const [
    vaults,
    devicesActive,
    devicesRevoked,
    filesLive,
    filesDeleted,
    fileRevisions,
    syncEvents,
    syncConflicts,
    allBlobs
  ] = await Promise.all([
    Promise.resolve(getCount(sql`select count(*) as value from vaults`)),
    Promise.resolve(getCount(sql`select count(*) as value from devices where revoked_at is null`)),
    Promise.resolve(getCount(sql`select count(*) as value from devices where revoked_at is not null`)),
    Promise.resolve(getCount(sql`select count(*) as value from files where deleted = 0`)),
    Promise.resolve(getCount(sql`select count(*) as value from files where deleted != 0`)),
    Promise.resolve(getCount(sql`select count(*) as value from file_revisions`)),
    Promise.resolve(getCount(sql`select count(*) as value from events`)),
    Promise.resolve(getCount(sql`select count(*) as value from conflicts`)),
    listAllBlobs()
  ]);

  return {
    vaults,
    devicesActive,
    devicesRevoked,
    filesLive,
    filesDeleted,
    fileRevisions,
    syncEvents,
    syncConflicts,
    blobCount: allBlobs.length,
    processUptimeSeconds: Math.floor(process.uptime())
  };
}

export function renderPrometheusMetrics(snapshot: MetricsSnapshot) {
  return [
    "# HELP obsidian_sync_vaults_total Total configured vaults.",
    "# TYPE obsidian_sync_vaults_total gauge",
    `obsidian_sync_vaults_total ${snapshot.vaults}`,
    "# HELP obsidian_sync_devices_active Total active devices.",
    "# TYPE obsidian_sync_devices_active gauge",
    `obsidian_sync_devices_active ${snapshot.devicesActive}`,
    "# HELP obsidian_sync_devices_revoked Total revoked devices.",
    "# TYPE obsidian_sync_devices_revoked gauge",
    `obsidian_sync_devices_revoked ${snapshot.devicesRevoked}`,
    "# HELP obsidian_sync_files_live Total non-deleted files.",
    "# TYPE obsidian_sync_files_live gauge",
    `obsidian_sync_files_live ${snapshot.filesLive}`,
    "# HELP obsidian_sync_files_deleted Total deleted file tombstones.",
    "# TYPE obsidian_sync_files_deleted gauge",
    `obsidian_sync_files_deleted ${snapshot.filesDeleted}`,
    "# HELP obsidian_sync_file_revisions_total Total file revisions.",
    "# TYPE obsidian_sync_file_revisions_total gauge",
    `obsidian_sync_file_revisions_total ${snapshot.fileRevisions}`,
    "# HELP obsidian_sync_events_total Total sync events.",
    "# TYPE obsidian_sync_events_total gauge",
    `obsidian_sync_events_total ${snapshot.syncEvents}`,
    "# HELP obsidian_sync_conflicts_total Total recorded sync conflicts.",
    "# TYPE obsidian_sync_conflicts_total gauge",
    `obsidian_sync_conflicts_total ${snapshot.syncConflicts}`,
    "# HELP obsidian_sync_blobs_total Total stored blobs.",
    "# TYPE obsidian_sync_blobs_total gauge",
    `obsidian_sync_blobs_total ${snapshot.blobCount}`,
    "# HELP obsidian_sync_process_uptime_seconds Server process uptime in seconds.",
    "# TYPE obsidian_sync_process_uptime_seconds gauge",
    `obsidian_sync_process_uptime_seconds ${snapshot.processUptimeSeconds}`
  ].join("\n");
}
