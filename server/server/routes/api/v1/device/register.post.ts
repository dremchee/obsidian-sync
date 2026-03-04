import { defineEventHandler, readBody, createError } from "h3";
import { eq } from "drizzle-orm";
import { devices, syncCursors, vaults } from "#app/db/schema";
import { getOrmDb } from "#app/utils/db";
import { generateApiKey, hashApiKey, newId, requireAuthToken } from "#app/utils/auth";
import { logError, logInfo } from "#app/utils/logger";

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  try {
    requireAuthToken(event);

    const body = await readBody<{ vaultName?: string; deviceName?: string }>(event);
    const vaultName = (body?.vaultName || "default").trim();
    const deviceName = (body?.deviceName || "device").trim();

    if (!vaultName || !deviceName) {
      throw createError({ statusCode: 400, statusMessage: "vaultName and deviceName are required" });
    }

    const db = getOrmDb();
    const now = Date.now();

    let [vault] = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.name, vaultName)).limit(1);
    if (!vault) {
      const id = newId("vault");
      await db.insert(vaults).values({ id, name: vaultName, createdAt: now });
      vault = { id };
      logInfo("device.register.vault_created", { vaultId: id, vaultName });
    }

    const apiKey = generateApiKey();
    const hashed = hashApiKey(apiKey);
    const deviceId = newId("dev");

    await db.insert(devices).values({
      id: deviceId,
      vaultId: vault.id,
      name: deviceName,
      apiKeyHash: hashed,
      createdAt: now,
      revokedAt: null
    });

    await db.insert(syncCursors).values({
      deviceId,
      cursorTs: 0,
      lastEventId: 0
    }).onConflictDoNothing();

    logInfo("device.register.done", {
      vaultId: vault.id,
      deviceId,
      deviceName,
      durationMs: Date.now() - startedAt
    });

    return {
      vaultId: vault.id,
      deviceId,
      apiKey,
      createdAt: now
    };
  } catch (error) {
    logError("device.register.failed", error, { durationMs: Date.now() - startedAt });
    throw error;
  }
});
