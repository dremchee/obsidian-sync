import { createError, defineEventHandler, getRouterParam, readRawBody } from "h3";
import { requireDevice } from "#app/utils/auth";
import { putBlob, sha256 } from "#app/utils/cas";

export default defineEventHandler(async (event) => {
  await requireDevice(event);
  const hash = getRouterParam(event, "hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid hash" });
  }

  const raw = (await readRawBody(event, false)) as Buffer | null;
  if (!raw || !raw.length) {
    throw createError({ statusCode: 400, statusMessage: "Missing binary payload" });
  }

  const actual = sha256(raw);
  if (actual !== hash) {
    throw createError({ statusCode: 400, statusMessage: `Hash mismatch: expected ${hash}, got ${actual}` });
  }

  putBlob(hash, raw);
  return { ok: true, hash, size: raw.length };
});
