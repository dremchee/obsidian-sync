import { and, eq } from "drizzle-orm";
import { createError, defineEventHandler, readBody } from "h3";
import { events, fileRevisions, files } from "#app/db/schema";
import { requireDevice, newId } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";

export default defineEventHandler(async (event) => {
  const requester = await requireDevice(event);
  const body = await readBody<{ path: string; revisionId: string }>(event);
  const path = body?.path?.trim();
  const revisionId = body?.revisionId?.trim();

  if (!path || !revisionId) {
    throw createError({ statusCode: 400, statusMessage: "path and revisionId are required" });
  }

  const db = getOrmDb();

  const file = db
    .select({ id: files.id, headRevisionId: files.headRevisionId })
    .from(files)
    .where(and(eq(files.vaultId, requester.vaultId), eq(files.path, path)))
    .limit(1)
    .get();

  if (!file) {
    throw createError({ statusCode: 404, statusMessage: "File not found" });
  }

  const source = db
    .select({ id: fileRevisions.id, blobHash: fileRevisions.blobHash, size: fileRevisions.size })
    .from(fileRevisions)
    .where(eq(fileRevisions.id, revisionId))
    .limit(1)
    .get();

  if (!source) {
    throw createError({ statusCode: 404, statusMessage: "Revision not found" });
  }

  const now = Date.now();
  const newRev = newId("rev");

  db.transaction((tx) => {
    tx.insert(fileRevisions).values({
      id: newRev,
      fileId: file.id,
      path,
      op: "upsert",
      blobHash: source.blobHash,
      size: source.size,
      deviceId: requester.deviceId,
      ts: now,
      prevRevisionId: file.headRevisionId
    }).run();

    tx
      .update(files)
      .set({ headRevisionId: newRev, deleted: 0, updatedAt: now })
      .where(eq(files.id, file.id))
      .run();

    tx.insert(events).values({
      vaultId: requester.vaultId,
      fileId: file.id,
      revisionId: newRev,
      ts: now
    }).run();
  });

  return { ok: true, revisionId: newRev };
});
