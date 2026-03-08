import { defineTask } from "nitropack/runtime";
import { runDataRetention } from "#app/utils/data-retention";
import { logError, logInfo } from "#app/utils/logger";

export default defineTask({
  meta: {
    name: "data-retention",
    description: "Purge old revisions, events, conflicts, sync operations, and orphan blobs"
  },
  run() {
    try {
      const stats = runDataRetention();
      logInfo("data.retention.done", stats);
      return { result: stats };
    } catch (error) {
      logError("data.retention.failed", error);
      throw error;
    }
  }
});
