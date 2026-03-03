import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "#app/db/client";
import { events, fileRevisions, files, syncOperations } from "#app/db/schema";
import { getOrmDb } from "#app/utils/db";
import { newId } from "#app/utils/auth";

export type PushOperation = {
  operationId?: string;
  op: "upsert" | "delete" | "rename";
  path: string;
  prevPath?: string;
  blobHash?: string;
  size?: number;
  clientTs?: number;
  baseRevisionId?: string;
};

function normalizePath(p: string) {
  return p.replaceAll("\\", "/").replace(/^\/+/, "");
}

function fileForPath(db: AppDb, vaultId: string, p: string) {
  const row = db
    .select({
      id: files.id,
      headRevisionId: files.headRevisionId,
      deleted: files.deleted
    })
    .from(files)
    .where(and(eq(files.vaultId, vaultId), eq(files.path, p)))
    .limit(1)
    .get();
  return row;
}

function ensureFile(db: AppDb, vaultId: string, p: string, ts: number) {
  const existing = fileForPath(db, vaultId, p);
  if (existing) return existing.id;

  const id = newId("file");
  db.insert(files).values({
    id,
    vaultId,
    path: p,
    deleted: 0,
    updatedAt: ts,
    headRevisionId: null
  }).run();
  return id;
}

function insertRevision(db: AppDb, args: {
  fileId: string;
  path: string;
  op: string;
  blobHash: string | null;
  size: number | null;
  deviceId: string;
  ts: number;
  prevRevisionId: string | null;
}) {
  const revisionId = newId("rev");
  db.insert(fileRevisions).values({
    id: revisionId,
    fileId: args.fileId,
    path: args.path,
    op: args.op,
    blobHash: args.blobHash,
    size: args.size,
    deviceId: args.deviceId,
    ts: args.ts,
    prevRevisionId: args.prevRevisionId
  }).run();
  return revisionId;
}

function insertEvent(db: AppDb, vaultId: string, fileId: string, revisionId: string, ts: number) {
  db.insert(events).values({
    vaultId,
    fileId,
    revisionId,
    ts
  }).run();
}

function getHeadTs(db: AppDb, fileId: string) {
  const row = db
    .select({
      id: fileRevisions.id,
      ts: fileRevisions.ts,
      deviceId: fileRevisions.deviceId
    })
    .from(files)
    .innerJoin(fileRevisions, eq(fileRevisions.id, files.headRevisionId))
    .where(eq(files.id, fileId))
    .limit(1)
    .get();

  return row;
}

function upsertFileHead(db: AppDb, fileId: string, revisionId: string, deleted: boolean, ts: number) {
  db
    .update(files)
    .set({
      headRevisionId: revisionId,
      deleted: deleted ? 1 : 0,
      updatedAt: ts
    })
    .where(eq(files.id, fileId))
    .run();
}

function movePath(db: AppDb, vaultId: string, fromPath: string, toPath: string) {
  db.update(files).set({ path: toPath }).where(and(eq(files.vaultId, vaultId), eq(files.path, fromPath))).run();
}

export function applyOperations(vaultId: string, deviceId: string, ops: PushOperation[]) {
  const db = getOrmDb();
  const now = Date.now();
  const results: Array<{
    operationId: string;
    status: "applied" | "duplicate" | "ignored";
    revisionId?: string;
    headRevisionId?: string;
    conflictPath?: string;
  }> = [];

  db.transaction((tx) => {
    for (const raw of ops) {
      const opId = raw.operationId || newId("op");
      const existingOp = tx
        .select({
          id: syncOperations.id,
          resultStatus: syncOperations.resultStatus,
          resultRevisionId: syncOperations.resultRevisionId,
          resultHeadRevisionId: syncOperations.resultHeadRevisionId,
          resultConflictPath: syncOperations.resultConflictPath
        })
        .from(syncOperations)
        .where(and(eq(syncOperations.deviceId, deviceId), eq(syncOperations.operationId, opId)))
        .limit(1)
        .get();

      if (existingOp) {
        results.push({
          operationId: opId,
          status: "duplicate",
          revisionId: existingOp.resultRevisionId || undefined,
          headRevisionId: existingOp.resultHeadRevisionId || undefined,
          conflictPath: existingOp.resultConflictPath || undefined
        });
        continue;
      }

      tx.insert(syncOperations).values({
        deviceId,
        operationId: opId,
        createdAt: now,
        resultStatus: null,
        resultRevisionId: null,
        resultHeadRevisionId: null,
        resultConflictPath: null
      }).run();

      const ts = raw.clientTs || Date.now();
      const op = raw.op;
      const p = normalizePath(raw.path);
      const setOpResult = (data: { status: "applied" | "ignored"; revisionId?: string; headRevisionId?: string }) => {
        tx
          .update(syncOperations)
          .set({
            resultStatus: data.status,
            resultRevisionId: data.revisionId || null,
            resultHeadRevisionId: data.headRevisionId || null,
            resultConflictPath: null
          })
          .where(and(eq(syncOperations.deviceId, deviceId), eq(syncOperations.operationId, opId)))
          .run();
      };

      if (op === "rename") {
        const from = normalizePath(raw.prevPath || "");
        if (!from || !p) {
          setOpResult({ status: "ignored" });
          results.push({ operationId: opId, status: "ignored" });
          continue;
        }

        const file = fileForPath(tx, vaultId, from);
        if (!file) {
          setOpResult({ status: "ignored" });
          results.push({ operationId: opId, status: "ignored" });
          continue;
        }

        const head = getHeadTs(tx, file.id);
        const staleBase = Boolean(raw.baseRevisionId && head?.id && raw.baseRevisionId !== head.id);
        const incomingWins = !head || ts > head.ts || (ts === head.ts && deviceId > head.deviceId);
        if (staleBase || !incomingWins) {
          setOpResult({ status: "ignored", headRevisionId: head?.id || undefined });
          results.push({ operationId: opId, status: "ignored", headRevisionId: head?.id || undefined });
          continue;
        }

        movePath(tx, vaultId, from, p);
        const rev = insertRevision(tx, {
          fileId: file.id,
          path: p,
          op: "rename",
          blobHash: null,
          size: null,
          deviceId,
          ts,
          prevRevisionId: head?.id || null
        });
        upsertFileHead(tx, file.id, rev, false, ts);
        insertEvent(tx, vaultId, file.id, rev, ts);
        setOpResult({ status: "applied", revisionId: rev, headRevisionId: rev });
        results.push({ operationId: opId, status: "applied", revisionId: rev });
        continue;
      }

      const fileId = ensureFile(tx, vaultId, p, ts);
      const head = getHeadTs(tx, fileId);
      const staleBase = Boolean(raw.baseRevisionId && head?.id && raw.baseRevisionId !== head.id);
      const incomingWins = !head || ts > head.ts || (ts === head.ts && deviceId > head.deviceId);

      if (staleBase || !incomingWins) {
        setOpResult({ status: "ignored", headRevisionId: head?.id || undefined });
        results.push({ operationId: opId, status: "ignored", headRevisionId: head?.id || undefined });
        continue;
      }

      const rev = insertRevision(tx, {
        fileId,
        path: p,
        op,
        blobHash: raw.blobHash || null,
        size: raw.size || null,
        deviceId,
        ts,
        prevRevisionId: head?.id || null
      });
      upsertFileHead(tx, fileId, rev, op === "delete", ts);
      insertEvent(tx, vaultId, fileId, rev, ts);
      setOpResult({ status: "applied", revisionId: rev, headRevisionId: rev });
      results.push({ operationId: opId, status: "applied", revisionId: rev, headRevisionId: rev });
    }
  });

  return results;
}

export function getReferencedBlobHashes() {
  const db = getOrmDb();
  const rows = db
    .selectDistinct({ blobHash: fileRevisions.blobHash })
    .from(fileRevisions)
    .where(sql`${fileRevisions.blobHash} IS NOT NULL`)
    .all();
  return rows.map((r) => r.blobHash!).filter(Boolean);
}
