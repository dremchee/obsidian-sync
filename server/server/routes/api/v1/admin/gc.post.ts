import { createError, defineEventHandler, getHeader, readBody } from "h3";
import { deleteBlob, listAllBlobs } from "#app/utils/cas";
import { getReferencedBlobHashes } from "#app/utils/sync-core";
import { useRuntimeConfig } from "nitropack/runtime";
import { logError, logInfo, logWarn } from "#app/utils/logger";

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  try {
    const cfg = useRuntimeConfig();
    const token = getHeader(event, "x-admin-token") || "";

    if (!cfg.adminToken || token !== cfg.adminToken) {
      logWarn("admin.gc.unauthorized");
      throw createError({ statusCode: 401, statusMessage: "Invalid admin token" });
    }

    const body = await readBody<{ dryRun?: boolean }>(event);
    const dryRun = Boolean(body?.dryRun);

    const set = new Set(getReferencedBlobHashes());
    const all = listAllBlobs();
    const orphans = all.filter((h) => !set.has(h));

    let deleted = 0;
    if (!dryRun) {
      for (const hash of orphans) {
        if (deleteBlob(hash)) {
          deleted += 1;
        }
      }
    }

    logInfo("admin.gc.done", {
      dryRun,
      totalBlobs: all.length,
      referenced: set.size,
      orphanCount: orphans.length,
      deleted,
      durationMs: Date.now() - startedAt
    });

    return {
      dryRun,
      totalBlobs: all.length,
      referenced: set.size,
      orphanCount: orphans.length,
      deleted
    };
  } catch (error) {
    logError("admin.gc.failed", error, { durationMs: Date.now() - startedAt });
    throw error;
  }
});
