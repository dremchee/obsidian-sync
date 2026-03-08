import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { createError, getHeader, H3Event } from "h3";
import { devices } from "#app/db/schema";
import { getOrmDb } from "#app/utils/db";
import { useRuntimeConfig } from "nitropack/runtime";

export function generateApiKey() {
  return `osk_${randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(apiKey: string) {
  const cfg = useRuntimeConfig();
  return createHash("sha256").update(`${apiKey}:${cfg.apiKeyPepper || ""}`).digest("hex");
}

export function hashPassphrase(passphrase: string) {
  return createHash("sha256").update(passphrase).digest("hex");
}

export function newId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function requireAuthToken(event: H3Event) {
  const cfg = useRuntimeConfig();
  const configured = String(cfg.authToken || "").trim();
  if (!configured) {
    throw createError({ statusCode: 500, statusMessage: "Server auth token is not configured" });
  }
  const provided = String(getHeader(event, "x-auth-token") || "").trim();
  if (!provided || provided !== configured) {
    throw createError({ statusCode: 403, statusMessage: "Invalid auth token" });
  }
}

export async function requireDevice(event: H3Event) {
  const header = getHeader(event, "authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw createError({ statusCode: 401, statusMessage: "Missing bearer token" });
  }

  const token = header.slice("Bearer ".length).trim();
  const hashed = hashApiKey(token);
  const db = getOrmDb();

  const [row] = await db
    .select({
      id: devices.id,
      vaultId: devices.vaultId,
      name: devices.name
    })
    .from(devices)
    .where(and(eq(devices.apiKeyHash, hashed), isNull(devices.revokedAt)))
    .limit(1);

  if (!row) {
    throw createError({ statusCode: 401, statusMessage: "Invalid or revoked API key" });
  }

  return { deviceId: row.id, vaultId: row.vaultId, deviceName: row.name };
}
