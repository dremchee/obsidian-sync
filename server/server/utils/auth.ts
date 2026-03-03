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

export function newId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
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
