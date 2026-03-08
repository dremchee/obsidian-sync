import { defineEventHandler, readBody, createError } from "h3";
import { SERVER_SYNC_LIMITS } from "#app/constants";
import { hasBlob } from "#app/utils/cas";
import { requireDevice } from "#app/utils/auth";

type Body = {
  hashes?: string[];
};

export default defineEventHandler(async (event) => {
  await requireDevice(event);
  const body = await readBody<Body>(event);
  const hashes = Array.isArray(body?.hashes) ? body.hashes : [];

  if (hashes.length > SERVER_SYNC_LIMITS.blobBatchMissingMaxHashes) {
    throw createError({
      statusCode: 400,
      statusMessage: `Too many hashes (max ${SERVER_SYNC_LIMITS.blobBatchMissingMaxHashes})`
    });
  }

  const uniq = Array.from(new Set(hashes.map((h) => String(h || "").toLowerCase().trim()).filter(Boolean)));
  for (const hash of uniq) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw createError({ statusCode: 400, statusMessage: `Invalid hash: ${hash}` });
    }
  }

  const missing: string[] = [];
  for (const hash of uniq) {
    if (!(await hasBlob(hash))) {
      missing.push(hash);
    }
  }
  return { missing };
});
