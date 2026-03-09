import path from "node:path";
import { cp, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { useRuntimeConfig } from "nitropack/runtime";
import { resolveDataPaths } from "#app/utils/paths";

export type BackupSummary = {
  backupDir: string;
  startedAt: string;
  finishedAt: string;
  deletedBackups: number;
  blobFiles: number;
  blobBytes: number;
};

type BackupEntry = {
  name: string;
  mtimeMs: number;
  isDirectory: boolean;
};

export function formatBackupStamp(date: Date) {
  const iso = date.toISOString().replace(/[-:]/g, "");
  return iso.slice(0, 8) + "-" + iso.slice(9, 15);
}

export function pruneExpiredBackups(entries: BackupEntry[], nowMs: number, retentionDays: number) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => entry.isDirectory && nowMs - entry.mtimeMs > retentionMs);
}

async function collectDirectoryStats(dirPath: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectDirectoryStats(entryPath);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(entryPath);
    files += 1;
    bytes += info.size;
  }
  return { files, bytes };
}

async function cleanupExpiredBackups(backupsPath: string, retentionDays: number, nowMs: number) {
  const entries = await readdir(backupsPath, { withFileTypes: true });
  const stats = await Promise.all(entries.map(async (entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    mtimeMs: (await stat(path.join(backupsPath, entry.name))).mtimeMs
  })));
  const expired = pruneExpiredBackups(stats, nowMs, retentionDays);
  await Promise.all(expired.map((entry) => rm(path.join(backupsPath, entry.name), { recursive: true, force: true })));
  return expired.length;
}

export async function runBackupNow(now = new Date()): Promise<BackupSummary> {
  const cfg = useRuntimeConfig();
  const { dbPath, blobsPath, backupsPath } = resolveDataPaths();
  const stamp = formatBackupStamp(now);
  const backupDir = path.join(backupsPath, stamp);
  const backupBlobsPath = path.join(backupDir, "blobs");
  const startedAt = now.toISOString();

  await mkdir(backupDir, { recursive: true });
  await copyFile(dbPath, path.join(backupDir, "app.db"));
  await cp(blobsPath, backupBlobsPath, { recursive: true, force: true });

  const blobStats = await collectDirectoryStats(backupBlobsPath);
  const deletedBackups = await cleanupExpiredBackups(
    backupsPath,
    Number(cfg.backupRetentionDays || process.env.BACKUP_RETENTION_DAYS || 7),
    now.getTime()
  );
  const finishedAt = new Date().toISOString();

  await writeFile(
    path.join(backupDir, "metadata.json"),
    JSON.stringify(
      {
        startedAt,
        finishedAt,
        deletedBackups,
        blobFiles: blobStats.files,
        blobBytes: blobStats.bytes
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    backupDir,
    startedAt,
    finishedAt,
    deletedBackups,
    blobFiles: blobStats.files,
    blobBytes: blobStats.bytes
  };
}
