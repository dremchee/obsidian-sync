import fs from "node:fs";
import path from "node:path";
import { useRuntimeConfig } from "nitropack/runtime";

export function resolveDataPaths() {
  const cfg = useRuntimeConfig();
  const base = path.resolve(process.cwd(), cfg.dataDir || "../data");
  const dbPath = path.join(base, "app.db");
  const blobsPath = path.join(base, "blobs");
  const backupsPath = path.join(base, "backups");
  const logsPath = path.join(base, "logs");

  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(blobsPath, { recursive: true });
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(logsPath, { recursive: true });

  return { base, dbPath, blobsPath, backupsPath, logsPath };
}
