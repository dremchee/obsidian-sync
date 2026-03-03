import { createError, defineEventHandler, readBody } from "h3";
import { and, eq } from "drizzle-orm";
import { devices } from "#app/db/schema";
import { requireDevice } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";

export default defineEventHandler(async (event) => {
  const requester = await requireDevice(event);
  const body = await readBody<{ deviceId: string }>(event);
  const target = body?.deviceId;

  if (!target) {
    throw createError({ statusCode: 400, statusMessage: "deviceId is required" });
  }

  const db = getOrmDb();
  const [row] = await db
    .select({ id: devices.id, vaultId: devices.vaultId })
    .from(devices)
    .where(eq(devices.id, target))
    .limit(1);

  if (!row || row.vaultId !== requester.vaultId) {
    throw createError({ statusCode: 404, statusMessage: "Device not found" });
  }

  await db
    .update(devices)
    .set({ revokedAt: Date.now() })
    .where(and(eq(devices.id, target), eq(devices.vaultId, requester.vaultId)));

  return { ok: true };
});
