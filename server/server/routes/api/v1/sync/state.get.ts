import { defineEventHandler } from "h3";
import { eq, sql } from "drizzle-orm";
import { events } from "#app/db/schema";
import { requireDevice } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";

export default defineEventHandler(async (event) => {
  const requester = await requireDevice(event);
  const db = getOrmDb();

  const [row] = await db
    .select({ maxEventId: sql<number>`coalesce(max(${events.id}), 0)` })
    .from(events)
    .where(eq(events.vaultId, requester.vaultId));

  return {
    vaultId: requester.vaultId,
    lastEventId: row?.maxEventId || 0,
    serverTime: Date.now()
  };
});
