import fs from "node:fs";
import path from "node:path";
import { useRuntimeConfig } from "nitropack/runtime";
import { resolveDataPaths } from "#app/utils/paths";
import { runLogRetention } from "#app/utils/log-retention";

type LogLevel = "debug" | "info" | "warn" | "error";
type SensitiveMode = "redact" | "omit";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const SENSITIVE_KEY_RE = /(authorization|api[-_]?key|token|password|secret|cookie|set-cookie|passphrase)/i;
const BEARER_RE = /\b(Bearer)\s+([A-Za-z0-9._~+/=-]+)/gi;
const BASIC_RE = /\b(Basic)\s+([A-Za-z0-9._~+/=-]+)/gi;
const OMIT = Symbol("omit");
let cachedLogFilePath: string | null = null;

function redactString(value: string): string {
  return value
    .replace(BEARER_RE, "$1 [REDACTED]")
    .replace(BASIC_RE, "$1 [REDACTED]");
}

function sensitiveMode(): SensitiveMode {
  try {
    const cfg = useRuntimeConfig();
    const mode = String(cfg.logSensitiveMode || "").toLowerCase();
    return mode === "omit" ? "omit" : "redact";
  } catch {
    return String(process.env.LOG_SENSITIVE_MODE || "").toLowerCase() === "omit" ? "omit" : "redact";
  }
}

function redactValue(value: unknown, keyHint?: string, depth = 0, mode: SensitiveMode = sensitiveMode()): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) {
      return mode === "omit" ? OMIT : "[REDACTED]";
    }
    return redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) {
      return mode === "omit" ? OMIT : "[REDACTED]";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => redactValue(item, keyHint, depth + 1, mode))
      .filter((item) => item !== OMIT);
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactValue(v, k, depth + 1, mode);
      if (redacted !== OMIT) {
        out[k] = redacted;
      }
    }
    return out;
  }

  return String(value);
}

function normalizeLevel(value: string | undefined): LogLevel {
  const v = (value || "").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") {
    return v;
  }
  return "info";
}

function currentLevel(): LogLevel {
  try {
    const cfg = useRuntimeConfig();
    return normalizeLevel(cfg.logLevel as string | undefined);
  } catch {
    return normalizeLevel(process.env.LOG_LEVEL);
  }
}

function shouldLog(level: LogLevel): boolean {
  return levelWeight[level] >= levelWeight[currentLevel()];
}

function normalizeError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactString(error.message),
      stack: error.stack ? redactString(error.stack) : undefined
    };
  }
  return { message: redactString(String(error)) };
}

function getLogFilePath() {
  if (cachedLogFilePath) return cachedLogFilePath;
  const { logsPath } = resolveDataPaths();
  cachedLogFilePath = path.join(logsPath, "server.log");
  return cachedLogFilePath;
}

function writeToLogFile(line: string) {
  try {
    fs.appendFileSync(getLogFilePath(), `${line}\n`, "utf8");
  } catch {
    // Keep request path resilient even if file logging is not writable.
  }
}

export function cleanupLogsNow() {
  try {
    return runLogRetention(getLogFilePath());
  } catch {
    return undefined;
  }
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const safeMeta = redactValue(meta);
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(safeMeta === OMIT ? undefined : (safeMeta as Record<string, unknown> | undefined))
  };
  const line = JSON.stringify(payload);
  writeToLogFile(line);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export function logDebug(message: string, meta?: Record<string, unknown>) {
  emit("debug", message, meta);
}

export function logInfo(message: string, meta?: Record<string, unknown>) {
  emit("info", message, meta);
}

export function logWarn(message: string, meta?: Record<string, unknown>) {
  emit("warn", message, meta);
}

export function logError(message: string, error?: unknown, meta?: Record<string, unknown>) {
  emit("error", message, {
    ...meta,
    error: normalizeError(error)
  });
}

export function logByStatus(message: string, statusCode: number, meta?: Record<string, unknown>) {
  if (statusCode >= 500) {
    emit("error", message, meta);
    return;
  }
  if (statusCode >= 400) {
    emit("warn", message, meta);
    return;
  }
  emit("info", message, meta);
}
