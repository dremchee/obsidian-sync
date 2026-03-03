import { defineTask } from "nitropack/runtime";
import { cleanupLogsNow, logError, logInfo } from "#app/utils/logger";

export default defineTask({
  meta: {
    name: "log-retention",
    description: "Delete old log entries/files based on LOG_RETENTION_DAYS"
  },
  run() {
    try {
      const stats = cleanupLogsNow();
      logInfo("logs.retention.done", stats);
      return { result: stats };
    } catch (error) {
      logError("logs.retention.failed", error);
      throw error;
    }
  }
});
