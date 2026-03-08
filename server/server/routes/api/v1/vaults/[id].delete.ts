import { eq, inArray } from "drizzle-orm";
import { createError, defineEventHandler, readBody } from "h3";
import { conflicts, devices, events, fileRevisions, files, syncCursors, syncOperations, vaults } from "#app/db/schema";
import { hashPassphrase, requireAuthToken } from "#app/utils/auth";
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

    const body = await readBody<{ passphrase?: string }>(event);
    const passphrase = (body?.passphrase || "").trim();
    if (!passphrase) {
      throw createError({ statusCode: 400, statusMessage: "passphrase is required" });
    }

    const db = getOrmDb();
    const vault = db
      .select({ id: vaults.id, passphraseHash: vaults.passphraseHash })
      .from(vaults)
      .where(eq(vaults.id, vaultId))
      .limit(1)
      .get();

    if (!vault) {
      throw createError({ statusCode: 404, statusMessage: "Vault not found" });
    }

    if (vault.passphraseHash && vault.passphraseHash !== hashPassphrase(passphrase)) {
      throw createError({ statusCode: 403, statusMessage: "Invalid passphrase" });
    }

    const deviceIds = db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.vaultId, vaultId))
      .all()
      .map((r) => r.id);

    const fileIds = db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.vaultId, vaultId))
      .all()
      .map((r) => r.id);

    db.transaction((tx) => {
      // Delete in dependency order
      if (fileIds.length) {
        tx.delete(conflicts).where(inArray(conflicts.fileId, fileIds)).run();
        tx.delete(fileRevisions).where(inArray(fileRevisions.fileId, fileIds)).run();
      }
      tx.delete(events).where(eq(events.vaultId, vaultId)).run();
      tx.delete(files).where(eq(files.vaultId, vaultId)).run();

      if (deviceIds.length) {
        tx.delete(syncCursors).where(inArray(syncCursors.deviceId, deviceIds)).run();
        tx.delete(syncOperations).where(inArray(syncOperations.deviceId, deviceIds)).run();
      }
      tx.delete(devices).where(eq(devices.vaultId, vaultId)).run();
      tx.delete(vaults).where(eq(vaults.id, vaultId)).run();
    });

    logInfo("vaults.delete", {
      vaultId,
      deletedDevices: deviceIds.length,
      deletedFiles: fileIds.length,
      durationMs: Date.now() - startedAt
    });

    return { deleted: true };
  } catch (error) {
    logError("vaults.delete.failed", error, { vaultId, durationMs: Date.now() - startedAt });
    throw error;
  }
});
