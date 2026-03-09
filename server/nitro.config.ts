import { defineNitroConfig } from "nitropack/config";

const scheduledTasks: Record<string, string> = {
  [process.env.LOG_RETENTION_CRON || "0 3 * * *"]: "log-retention",
  [process.env.DATA_RETENTION_CRON || "0 4 * * *"]: "data-retention"
};

const backupCron = process.env.BACKUP_CRON || "0 2 * * *";
if (backupCron) {
  scheduledTasks[backupCron] = "backup";
}

export default defineNitroConfig({
  srcDir: "server",
  compatibilityDate: "2026-03-03",
  experimental: {
    tasks: true,
    websocket: true
  },
  scheduledTasks,
  runtimeConfig: {
    dataDir: process.env.DATA_DIR || "../data",
    adminToken: process.env.ADMIN_TOKEN || "",
    authToken: process.env.AUTH_TOKEN || "",
    apiKeyPepper: process.env.API_KEY_PEPPER || "",
    logLevel: process.env.LOG_LEVEL || "info",
    logSensitiveMode: process.env.LOG_SENSITIVE_MODE || "redact",
    logRetentionDays: process.env.LOG_RETENTION_DAYS || "1",
    dataRetentionDays: process.env.DATA_RETENTION_DAYS || "30",
    backupRetentionDays: process.env.BACKUP_RETENTION_DAYS || "7"
  }
});
