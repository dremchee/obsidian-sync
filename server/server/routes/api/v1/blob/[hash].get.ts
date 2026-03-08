import { createError, defineEventHandler, getRouterParam, setHeader } from "h3";
import { requireDevice } from "#app/utils/auth";
import { hasBlob, readBlob } from "#app/utils/cas";

export default defineEventHandler(async (event) => {
  await requireDevice(event);
  const hash = getRouterParam(event, "hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid hash" });
  }

  if (!(await hasBlob(hash))) {
    throw createError({ statusCode: 404, statusMessage: "Blob not found" });
  }

  const payload = await readBlob(hash);
  setHeader(event, "content-type", "application/octet-stream");
  setHeader(event, "content-length", payload.length);
  return payload;
});
