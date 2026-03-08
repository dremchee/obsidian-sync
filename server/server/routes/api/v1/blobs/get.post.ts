import { createError, defineEventHandler, readBody } from "h3";
import { SERVER_SYNC_LIMITS } from "#app/constants";
import { hasBlob, readBlob } from "#app/utils/cas";
import { requireDevice } from "#app/utils/auth";

type Body = { hashes?: string[] };

export default defineEventHandler(async (event) => {
  await requireDevice(event);
  const body = await readBody<Body>(event);
  const hashes = Array.isArray(body?.hashes) ? body.hashes : [];

  if (!hashes.length) {
    return { items: [], missing: [] as string[] };
  }

  if (hashes.length > SERVER_SYNC_LIMITS.blobBatchGetMaxHashes) {
    throw createError({
      statusCode: 400,
      statusMessage: `Too many hashes (max ${SERVER_SYNC_LIMITS.blobBatchGetMaxHashes})`
    });
  }

  const normalized = Array.from(new Set(hashes.map((h) => String(h).trim().toLowerCase())));
  for (const hash of normalized) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw createError({ statusCode: 400, statusMessage: `Invalid hash: ${hash}` });
    }
  }

  const items: Array<{ hash: string; dataBase64: string }> = [];
  const missing: string[] = [];
  for (const hash of normalized) {
    if (!(await hasBlob(hash))) {
      missing.push(hash);
      continue;
    }
    const payload = await readBlob(hash);
    items.push({ hash, dataBase64: payload.toString("base64") });
  }

  return { items, missing };
});
