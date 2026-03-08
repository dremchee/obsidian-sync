import { eq } from "drizzle-orm";
import { createError, defineEventHandler, readBody } from "h3";
import { vaults } from "#app/db/schema";
import { hashPassphrase, requireAuthToken } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";

export default defineEventHandler(async (event) => {
  requireAuthToken(event);

  const vaultId = (event.context.params as Record<string, string>)?.id;
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

  if (!vault.passphraseHash) {
    return { valid: true };
  }

  const valid = vault.passphraseHash === hashPassphrase(passphrase);
  if (!valid) {
    throw createError({ statusCode: 403, statusMessage: "Invalid passphrase" });
  }

  return { valid: true };
});
