import { createError, defineEventHandler, getRouterParam, sendStream, setHeader } from "h3";
import { requireDevice } from "#app/utils/auth";
import { hasBlob, statBlob, streamBlob } from "#app/utils/cas";
import { recordBlobDownloadBytes } from "#app/utils/metrics";

export default defineEventHandler(async (event) => {
  await requireDevice(event);
  const hash = getRouterParam(event, "hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid hash" });
  }

  if (!(await hasBlob(hash))) {
    throw createError({ statusCode: 404, statusMessage: "Blob not found" });
  }

  const info = await statBlob(hash);
  recordBlobDownloadBytes(info.size);
  setHeader(event, "content-type", "application/octet-stream");
  setHeader(event, "content-length", info.size);
  return sendStream(event, streamBlob(hash));
});
