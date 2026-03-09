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
  blobUploadBytesTotal: number;
  blobDownloadBytesTotal: number;
  blobBatchRequestsTotal: number;
  blobBatchItemsTotal: number;
  blobBatchDeferredTotal: number;
  blobBatchMissingTotal: number;
  processUptimeSeconds: number;
};

const runtimeCounters = {
  blobUploadBytesTotal: 0,
  blobDownloadBytesTotal: 0,
  blobBatchRequestsTotal: 0,
  blobBatchItemsTotal: 0,
  blobBatchDeferredTotal: 0,
  blobBatchMissingTotal: 0
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
    blobUploadBytesTotal: runtimeCounters.blobUploadBytesTotal,
    blobDownloadBytesTotal: runtimeCounters.blobDownloadBytesTotal,
    blobBatchRequestsTotal: runtimeCounters.blobBatchRequestsTotal,
    blobBatchItemsTotal: runtimeCounters.blobBatchItemsTotal,
    blobBatchDeferredTotal: runtimeCounters.blobBatchDeferredTotal,
    blobBatchMissingTotal: runtimeCounters.blobBatchMissingTotal,
    processUptimeSeconds: Math.floor(process.uptime())
  };
}

export function recordBlobUploadBytes(bytes: number) {
  runtimeCounters.blobUploadBytesTotal += Math.max(0, bytes);
}

export function recordBlobDownloadBytes(bytes: number) {
  runtimeCounters.blobDownloadBytesTotal += Math.max(0, bytes);
}

export function recordBlobBatchRequest(stats: {
  items: number;
  deferred: number;
  missing: number;
}) {
  runtimeCounters.blobBatchRequestsTotal += 1;
  runtimeCounters.blobBatchItemsTotal += Math.max(0, stats.items);
  runtimeCounters.blobBatchDeferredTotal += Math.max(0, stats.deferred);
  runtimeCounters.blobBatchMissingTotal += Math.max(0, stats.missing);
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
    "# HELP obsidian_sync_blob_upload_bytes_total Total bytes uploaded into blob storage since process start.",
    "# TYPE obsidian_sync_blob_upload_bytes_total counter",
    `obsidian_sync_blob_upload_bytes_total ${snapshot.blobUploadBytesTotal}`,
    "# HELP obsidian_sync_blob_download_bytes_total Total bytes downloaded from blob storage since process start.",
    "# TYPE obsidian_sync_blob_download_bytes_total counter",
    `obsidian_sync_blob_download_bytes_total ${snapshot.blobDownloadBytesTotal}`,
    "# HELP obsidian_sync_blob_batch_requests_total Total batch blob download requests since process start.",
    "# TYPE obsidian_sync_blob_batch_requests_total counter",
    `obsidian_sync_blob_batch_requests_total ${snapshot.blobBatchRequestsTotal}`,
    "# HELP obsidian_sync_blob_batch_items_total Total blob items emitted through batch download responses.",
    "# TYPE obsidian_sync_blob_batch_items_total counter",
    `obsidian_sync_blob_batch_items_total ${snapshot.blobBatchItemsTotal}`,
    "# HELP obsidian_sync_blob_batch_deferred_total Total blob hashes deferred from batch download responses.",
    "# TYPE obsidian_sync_blob_batch_deferred_total counter",
    `obsidian_sync_blob_batch_deferred_total ${snapshot.blobBatchDeferredTotal}`,
    "# HELP obsidian_sync_blob_batch_missing_total Total missing blob hashes reported by batch download responses.",
    "# TYPE obsidian_sync_blob_batch_missing_total counter",
    `obsidian_sync_blob_batch_missing_total ${snapshot.blobBatchMissingTotal}`,
    "# HELP obsidian_sync_process_uptime_seconds Server process uptime in seconds.",
    "# TYPE obsidian_sync_process_uptime_seconds gauge",
    `obsidian_sync_process_uptime_seconds ${snapshot.processUptimeSeconds}`
  ].join("\n");
}
