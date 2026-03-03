import fs from "node:fs";
import path from "node:path";
import { useRuntimeConfig } from "nitropack/runtime";
import { resolveDataPaths } from "#app/utils/paths";

type RetentionStats = {
  days: number;
  cutoffMs: number;
  linesDeleted: number;
  filesDeleted: number;
};

function retentionDays(): number {
  const fallback = 7;
  try {
    const cfg = useRuntimeConfig();
    const raw = Number.parseInt(String(cfg.logRetentionDays ?? ""), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  } catch {
    const raw = Number.parseInt(String(process.env.LOG_RETENTION_DAYS ?? ""), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
}

function parseLineTimestamp(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as { ts?: string };
    if (!parsed.ts) return null;
    const ms = Date.parse(parsed.ts);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function cleanupOldLogLines(logFilePath: string, cutoffMs: number): number {
  if (!fs.existsSync(logFilePath)) return 0;
  const input = fs.readFileSync(logFilePath, "utf8");
  if (!input) return 0;

  const lines = input.split("\n");
  const kept: string[] = [];
  let deleted = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const ts = parseLineTimestamp(line);
    if (ts === null || ts >= cutoffMs) {
      kept.push(line);
    } else {
      deleted += 1;
    }
  }

  if (deleted > 0) {
    const output = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    fs.writeFileSync(logFilePath, output, "utf8");
  }

  return deleted;
}

function cleanupOldLogFiles(cutoffMs: number, keepFilePath: string): number {
  const { logsPath } = resolveDataPaths();
  const files = fs.readdirSync(logsPath);
  let deleted = 0;

  for (const file of files) {
    const fullPath = path.join(logsPath, file);
    if (fullPath === keepFilePath) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoffMs) {
      fs.rmSync(fullPath, { force: true });
      deleted += 1;
    }
  }

  return deleted;
}

export function runLogRetention(logFilePath: string): RetentionStats {
  const days = retentionDays();
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const linesDeleted = cleanupOldLogLines(logFilePath, cutoffMs);
  const filesDeleted = cleanupOldLogFiles(cutoffMs, logFilePath);
  return { days, cutoffMs, linesDeleted, filesDeleted };
}

