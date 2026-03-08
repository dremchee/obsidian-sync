import { sql } from "drizzle-orm";
import { defineEventHandler } from "h3";
import { devices, vaults } from "#app/db/schema";
import { requireAuthToken } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";
import { logError, logInfo } from "#app/utils/logger";

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  try {
    requireAuthToken(event);

    const db = getOrmDb();
    const rows = db
      .select({
        id: vaults.id,
        name: vaults.name,
        createdAt: vaults.createdAt,
        deviceCount: sql<number>`(select count(*) from ${devices} where ${devices.vaultId} = ${vaults.id} and ${devices.revokedAt} is null)`
      })
      .from(vaults)
      .all();

    logInfo("vaults.list", { count: rows.length, durationMs: Date.now() - startedAt });

    return { vaults: rows };
  } catch (error) {
    logError("vaults.list.failed", error, { durationMs: Date.now() - startedAt });
    throw error;
  }
});
