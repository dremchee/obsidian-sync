import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireDevice } from "#app/utils/auth";
import { putBlobFromStream } from "#app/utils/cas";

export default defineEventHandler(async (event) => {
  await requireDevice(event);
  const hash = getRouterParam(event, "hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid hash" });
  }

  try {
    const result = await putBlobFromStream(hash, event.node.req);
    return { ok: true, hash, size: result.size };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Missing binary payload|Hash mismatch:/i.test(message)) {
      throw createError({ statusCode: 400, statusMessage: message });
    }
    throw error;
  }
});
