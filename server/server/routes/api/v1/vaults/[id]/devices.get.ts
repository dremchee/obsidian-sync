import { eq } from "drizzle-orm";
import { createError, defineEventHandler } from "h3";
import { devices, vaults } from "#app/db/schema";
import { requireAuthToken } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";
import { logError, logInfo } from "#app/utils/logger";

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  const vaultId = (event.context.params as Record<string, string>)?.id;
  try {
    requireAuthToken(event);

    if (!vaultId) {
      throw createError({ statusCode: 400, statusMessage: "vault id is required" });
    }

    const db = getOrmDb();
    const vault = db
      .select({ id: vaults.id })
      .from(vaults)
      .where(eq(vaults.id, vaultId))
      .limit(1)
      .get();

    if (!vault) {
      throw createError({ statusCode: 404, statusMessage: "Vault not found" });
    }

    const rows = db
      .select({
        id: devices.id,
        name: devices.name,
        createdAt: devices.createdAt,
        revokedAt: devices.revokedAt
      })
      .from(devices)
      .where(eq(devices.vaultId, vaultId))
      .all();

    logInfo("vaults.devices", { vaultId, count: rows.length, durationMs: Date.now() - startedAt });

    return { devices: rows };
  } catch (error) {
    logError("vaults.devices.failed", error, { vaultId, durationMs: Date.now() - startedAt });
    throw error;
  }
});
