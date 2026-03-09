import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { getOrmDb } from "#app/utils/db";
import { listAllBlobs } from "#app/utils/cas";
import { resolveDataPaths } from "#app/utils/paths";
import { collectMetricsSnapshot } from "#app/utils/metrics";

export type HealthCheckStatus = "ok" | "warn" | "fail";
export type HealthStatus = "ok" | "degraded" | "fail";

export type HealthSnapshot = {
  status: HealthStatus;
  time: number;
  checks: {
    db: HealthCheckStatus;
    storage: HealthCheckStatus;
    backups: HealthCheckStatus;
  };
  stats: {
    vaults: number;
    devicesActive: number;
    filesLive: number;
    blobCount: number;
    backupCount: number;
    latestBackupAt: string | null;
    blobUploadBytesTotal: number;
    blobDownloadBytesTotal: number;
    blobBatchRequestsTotal: number;
    blobBatchItemsTotal: number;
    blobBatchDeferredTotal: number;
    blobBatchMissingTotal: number;
    processUptimeSeconds: number;
  };
  errors?: string[];
};

function getCount(query: ReturnType<typeof sql>) {
  const db = getOrmDb();
  const row = db.get<{ value: number }>(query);
  return Number(row?.value || 0);
}

async function getBackupStats() {
  const { backupsPath } = resolveDataPaths();
  const entries = await readdir(backupsPath, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  let latestBackupAt: string | null = null;

  for (const entry of directories) {
    const entryStat = await stat(path.join(backupsPath, entry.name));
    const iso = entryStat.mtime.toISOString();
    if (!latestBackupAt || iso > latestBackupAt) {
      latestBackupAt = iso;
    }
  }

  return {
    backupCount: directories.length,
    latestBackupAt
  };
}

export function resolveHealthStatus(checks: HealthCheckStatus[]): HealthStatus {
  if (checks.includes("fail")) return "fail";
  if (checks.includes("warn")) return "degraded";
  return "ok";
}

export async function collectHealthSnapshot(): Promise<HealthSnapshot> {
  const errors: string[] = [];
  let dbStatus: HealthCheckStatus = "ok";
  let storageStatus: HealthCheckStatus = "ok";
  let backupsStatus: HealthCheckStatus = "ok";

  let vaults = 0;
  let devicesActive = 0;
  let filesLive = 0;
  let blobCount = 0;
  let backupCount = 0;
  let latestBackupAt: string | null = null;
  let blobUploadBytesTotal = 0;
  let blobDownloadBytesTotal = 0;
  let blobBatchRequestsTotal = 0;
  let blobBatchItemsTotal = 0;
  let blobBatchDeferredTotal = 0;
  let blobBatchMissingTotal = 0;

  try {
    const db = getOrmDb();
    const row = db.get<{ ok: number }>(sql`select 1 as ok`);
    if (row?.ok !== 1) {
      dbStatus = "fail";
      errors.push("db probe returned unexpected result");
    } else {
      vaults = getCount(sql`select count(*) as value from vaults`);
      devicesActive = getCount(sql`select count(*) as value from devices where revoked_at is null`);
      filesLive = getCount(sql`select count(*) as value from files where deleted = 0`);
    }
  } catch (error) {
    dbStatus = "fail";
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const blobs = await listAllBlobs();
    blobCount = blobs.length;
  } catch (error) {
    storageStatus = "fail";
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const backupStats = await getBackupStats();
    backupCount = backupStats.backupCount;
    latestBackupAt = backupStats.latestBackupAt;
    backupsStatus = backupCount > 0 ? "ok" : "warn";
    if (!backupCount) {
      errors.push("no backup snapshots found");
    }
  } catch (error) {
    backupsStatus = "warn";
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const metrics = await collectMetricsSnapshot();
    blobUploadBytesTotal = metrics.blobUploadBytesTotal;
    blobDownloadBytesTotal = metrics.blobDownloadBytesTotal;
    blobBatchRequestsTotal = metrics.blobBatchRequestsTotal;
    blobBatchItemsTotal = metrics.blobBatchItemsTotal;
    blobBatchDeferredTotal = metrics.blobBatchDeferredTotal;
    blobBatchMissingTotal = metrics.blobBatchMissingTotal;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    status: resolveHealthStatus([dbStatus, storageStatus, backupsStatus]),
    time: Date.now(),
    checks: {
      db: dbStatus,
      storage: storageStatus,
      backups: backupsStatus
    },
    stats: {
      vaults,
      devicesActive,
      filesLive,
      blobCount,
      backupCount,
      latestBackupAt,
      blobUploadBytesTotal,
      blobDownloadBytesTotal,
      blobBatchRequestsTotal,
      blobBatchItemsTotal,
      blobBatchDeferredTotal,
      blobBatchMissingTotal,
      processUptimeSeconds: Math.floor(process.uptime())
    },
    errors: errors.length ? errors : undefined
  };
}
