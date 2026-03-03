import { defineEventHandler } from "h3";
import { eq, sql } from "drizzle-orm";
import { events, syncCursors } from "#app/db/schema";
import { requireDevice } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";

export default defineEventHandler(async (event) => {
  const requester = await requireDevice(event);
  const db = getOrmDb();

  const [row] = await db
    .select({ maxEventId: sql<number>`coalesce(max(${events.id}), 0)` })
    .from(events)
    .where(eq(events.vaultId, requester.vaultId));

  const [cursorRow] = await db
    .select({ lastEventId: syncCursors.lastEventId, cursorTs: syncCursors.cursorTs })
    .from(syncCursors)
    .where(eq(syncCursors.deviceId, requester.deviceId))
    .limit(1);
  const headEventId = row?.maxEventId || 0;
  const deviceCursor = cursorRow?.lastEventId || 0;

  return {
    vaultId: requester.vaultId,
    headEventId,
    deviceCursor,
    pendingEstimate: Math.max(0, headEventId - deviceCursor),
    lastEventId: headEventId,
    serverTime: Date.now()
  };
});
