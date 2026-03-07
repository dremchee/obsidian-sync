import { createError, defineEventHandler, readBody } from "h3";
import { requireDevice } from "#app/utils/auth";
import { applyOperations, type PushOperation } from "#app/utils/sync-core";
import { hasBlob } from "#app/utils/cas";
import { logError, logInfo, logWarn } from "#app/utils/logger";

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  const reqId = String((event.context as Record<string, unknown>).requestId || "");
  try {
    const requester = await requireDevice(event);
    const body = await readBody<{ operations: PushOperation[] }>(event);
    const ops = body?.operations || [];

    if (!Array.isArray(ops)) {
      throw createError({ statusCode: 400, statusMessage: "operations must be an array" });
    }

    for (const op of ops) {
      if (op.op === "upsert") {
        if (!op.blobHash || typeof op.size !== "number") {
          throw createError({ statusCode: 400, statusMessage: "upsert requires blobHash and size" });
        }
        if (!hasBlob(op.blobHash)) {
          logWarn("sync.push.blob_missing", {
            vaultId: requester.vaultId,
            deviceId: requester.deviceId,
            blobHash: op.blobHash
          });
          throw createError({ statusCode: 400, statusMessage: `Blob not uploaded: ${op.blobHash}` });
        }
      }
    }

    const results = applyOperations(requester.vaultId, requester.deviceId, ops);
    const counters = results.reduce(
      (acc, r) => {
        acc[r.status] += 1;
        return acc;
      },
      { applied: 0, duplicate: 0, ignored: 0, conflict: 0 }
    );

    logInfo("sync.push.done", {
      reqId,
      vaultId: requester.vaultId,
      deviceId: requester.deviceId,
      operationCount: ops.length,
      durationMs: Date.now() - startedAt,
      ...counters
    });

    return { results };
  } catch (error) {
    logError("sync.push.failed", error, { reqId, durationMs: Date.now() - startedAt });
    throw error;
  }
});
