import { and, desc, eq } from "drizzle-orm";
import { createError, defineEventHandler, getQuery } from "h3";
import { fileRevisions, files } from "#app/db/schema";
import { requireDevice } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";

export default defineEventHandler(async (event) => {
  const requester = await requireDevice(event);
  const query = getQuery(event);
  const path = String(query.path || "").trim();

  if (!path) {
    throw createError({ statusCode: 400, statusMessage: "path is required" });
  }

  const db = getOrmDb();
  const [file] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.vaultId, requester.vaultId), eq(files.path, path)))
    .limit(1);

  if (!file) {
    throw createError({ statusCode: 404, statusMessage: "File not found" });
  }

  const versions = await db
    .select({
      id: fileRevisions.id,
      op: fileRevisions.op,
      blobHash: fileRevisions.blobHash,
      size: fileRevisions.size,
      deviceId: fileRevisions.deviceId,
      ts: fileRevisions.ts,
      prevRevisionId: fileRevisions.prevRevisionId
    })
    .from(fileRevisions)
    .where(eq(fileRevisions.fileId, file.id))
    .orderBy(desc(fileRevisions.ts));

  return { path, versions };
});
