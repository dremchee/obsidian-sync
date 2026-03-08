import { eq } from "drizzle-orm";
import { createError, defineEventHandler, readBody } from "h3";
import { vaults } from "#app/db/schema";
import { hashPassphrase, newId, requireAuthToken } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";
import { logError, logInfo } from "#app/utils/logger";

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  try {
    requireAuthToken(event);

    const body = await readBody<{ name?: string; passphrase?: string }>(event);
    const name = (body?.name || "").trim();
    const passphrase = (body?.passphrase || "").trim();

    if (!name) {
      throw createError({ statusCode: 400, statusMessage: "name is required" });
    }
    if (!passphrase) {
      throw createError({ statusCode: 400, statusMessage: "passphrase is required" });
    }

    const db = getOrmDb();
    const existing = db
      .select({ id: vaults.id })
      .from(vaults)
      .where(eq(vaults.name, name))
      .limit(1)
      .get();

    if (existing) {
      throw createError({ statusCode: 409, statusMessage: "Vault with this name already exists" });
    }

    const id = newId("vault");
    const now = Date.now();
    const passphraseHash = hashPassphrase(passphrase);
    db.insert(vaults).values({ id, name, passphraseHash, createdAt: now }).run();

    logInfo("vaults.create", { vaultId: id, name, durationMs: Date.now() - startedAt });

    return { id, name, createdAt: now };
  } catch (error) {
    logError("vaults.create.failed", error, { durationMs: Date.now() - startedAt });
    throw error;
  }
});
