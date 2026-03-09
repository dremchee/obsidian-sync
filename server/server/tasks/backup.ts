import { defineTask } from "nitropack/runtime";
import { runBackupNow } from "#app/utils/backup";
import { logError, logInfo } from "#app/utils/logger";

export default defineTask({
  meta: {
    name: "backup",
    description: "Create scheduled backup snapshots for app.db and blobs"
  },
  async run() {
    try {
      const stats = await runBackupNow();
      logInfo("backup.done", stats);
      return { result: stats };
    } catch (error) {
      logError("backup.failed", error);
      throw error;
    }
  }
});
