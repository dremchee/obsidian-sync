import { and, eq, lt, min, notInArray, sql } from "drizzle-orm";
import { conflicts, devices, events, fileRevisions, files, syncCursors, syncOperations, vaults } from "#app/db/schema";
import { deleteBlob, listAllBlobs } from "#app/utils/cas";
import { getOrmDb } from "#app/utils/db";
import { useRuntimeConfig } from "nitropack/runtime";

export type RetentionStats = {
  days: number;
  cutoffMs: number;
  syncOperationsDeleted: number;
  conflictsDeleted: number;
  eventsDeleted: number;
  revisionsDeleted: number;
  blobsDeleted: number;
};

function retentionDays(): number {
  const fallback = 30;
  try {
    const cfg = useRuntimeConfig();
    const raw = Number.parseInt(String(cfg.dataRetentionDays ?? ""), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  } catch {
    const raw = Number.parseInt(String(process.env.DATA_RETENTION_DAYS ?? ""), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
}

function purgeSyncOperations(cutoffMs: number): number {
  const db = getOrmDb();
  const result = db
    .delete(syncOperations)
    .where(lt(syncOperations.createdAt, cutoffMs))
    .run();
  return result.changes;
}

function purgeConflicts(cutoffMs: number): number {
  const db = getOrmDb();
  const result = db
    .delete(conflicts)
    .where(lt(conflicts.createdAt, cutoffMs))
    .run();
  return result.changes;
}

function purgeSyncedEvents(): number {
  const db = getOrmDb();
  let totalDeleted = 0;

  const allVaults = db.select({ id: vaults.id }).from(vaults).all();

  for (const vault of allVaults) {
    const vaultDevices = db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.vaultId, vault.id), sql`${devices.revokedAt} IS NULL`))
      .all();

    if (vaultDevices.length === 0) continue;

    const minCursor = db
      .select({ minEventId: min(syncCursors.lastEventId) })
      .from(syncCursors)
      .where(
        sql`${syncCursors.deviceId} IN (${sql.join(
          vaultDevices.map((d) => sql`${d.id}`),
          sql`, `
        )})`
      )
      .get();

    const safeEventId = minCursor?.minEventId;
    if (!safeEventId || safeEventId <= 0) continue;

    const result = db
      .delete(events)
      .where(and(eq(events.vaultId, vault.id), lt(events.id, safeEventId)))
      .run();

    totalDeleted += result.changes;
  }

  return totalDeleted;
}

function purgeOldRevisions(cutoffMs: number): number {
  const db = getOrmDb();

  const headRevisionIds = db
    .selectDistinct({ id: files.headRevisionId })
    .from(files)
    .where(sql`${files.headRevisionId} IS NOT NULL`)
    .all()
    .map((r) => r.id!);

  if (headRevisionIds.length === 0) return 0;

  const result = db
    .delete(fileRevisions)
    .where(
      and(
        lt(fileRevisions.ts, cutoffMs),
        notInArray(fileRevisions.id, headRevisionIds)
      )
    )
    .run();

  return result.changes;
}

async function purgeOrphanBlobs(): Promise<number> {
  const db = getOrmDb();
  const referenced = new Set(
    db
      .selectDistinct({ blobHash: fileRevisions.blobHash })
      .from(fileRevisions)
      .where(sql`${fileRevisions.blobHash} IS NOT NULL`)
      .all()
      .map((r) => r.blobHash!)
  );

  const all = await listAllBlobs();
  let deleted = 0;
  for (const hash of all) {
    if (!referenced.has(hash)) {
      if (await deleteBlob(hash)) deleted += 1;
    }
  }
  return deleted;
}

export async function runDataRetention(): Promise<RetentionStats> {
  const days = retentionDays();
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const syncOperationsDeleted = purgeSyncOperations(cutoffMs);
  const conflictsDeleted = purgeConflicts(cutoffMs);
  const eventsDeleted = purgeSyncedEvents();
  const revisionsDeleted = purgeOldRevisions(cutoffMs);
  const blobsDeleted = await purgeOrphanBlobs();

  return {
    days,
    cutoffMs,
    syncOperationsDeleted,
    conflictsDeleted,
    eventsDeleted,
    revisionsDeleted,
    blobsDeleted
  };
}
