import { and, asc, eq, gt } from "drizzle-orm";
import { defineEventHandler, readBody } from "h3";
import { events, fileRevisions, syncCursors } from "#app/db/schema";
import { requireDevice } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";
import { logError, logInfo } from "#app/utils/logger";

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  const reqId = String((event.context as Record<string, unknown>).requestId || "");
  try {
    const requester = await requireDevice(event);
    const body = await readBody<{ afterEventId?: number; limit?: number; includeDeleted?: boolean }>(event);
    const after = Math.max(0, body?.afterEventId || 0);
    const limit = Math.min(1000, Math.max(1, body?.limit || 200));
    const includeDeleted = body?.includeDeleted !== false;

    const db = getOrmDb();
    const rows = await db
      .select({
        eventId: events.id,
        eventTs: events.ts,
        revisionId: fileRevisions.id,
        path: fileRevisions.path,
        op: fileRevisions.op,
        blobHash: fileRevisions.blobHash,
        size: fileRevisions.size,
        deviceId: fileRevisions.deviceId,
        revisionTs: fileRevisions.ts
      })
      .from(events)
      .innerJoin(fileRevisions, eq(fileRevisions.id, events.revisionId))
      .where(and(eq(events.vaultId, requester.vaultId), gt(events.id, after)))
      .orderBy(asc(events.id))
      .limit(limit);
    const filteredRows = includeDeleted ? rows : rows.filter((r) => r.op !== "delete");

    const last = rows.length ? rows[rows.length - 1].eventId : after;

    await db
      .insert(syncCursors)
      .values({ deviceId: requester.deviceId, cursorTs: Date.now(), lastEventId: last })
      .onConflictDoUpdate({
        target: syncCursors.deviceId,
        set: { cursorTs: Date.now(), lastEventId: last }
      });

    logInfo("sync.pull.done", {
      reqId,
      vaultId: requester.vaultId,
      deviceId: requester.deviceId,
      afterEventId: after,
      returnedEvents: filteredRows.length,
      includeDeleted,
      nextAfterEventId: last,
      durationMs: Date.now() - startedAt
    });

    return {
      events: filteredRows,
      nextAfterEventId: last
    };
  } catch (error) {
    logError("sync.pull.failed", error, { reqId, durationMs: Date.now() - startedAt });
    throw error;
  }
});
