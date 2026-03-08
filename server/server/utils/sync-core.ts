import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "#app/db/client";
import { conflicts, events, fileRevisions, files, syncOperations } from "#app/db/schema";
import { getOrmDb } from "#app/utils/db";
import { newId } from "#app/utils/auth";
import { syncEventBus } from "#app/utils/event-bus";
import { normalizeSyncPath } from "../../../shared/path";

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

function makeConflictPath(originalPath: string, deviceId: string, ts: number): string {
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const short = deviceId.length > 8 ? deviceId.slice(-8) : deviceId;
  const lastDot = originalPath.lastIndexOf(".");
  const lastSlash = originalPath.lastIndexOf("/");
  if (lastDot > lastSlash + 1) {
    return `${originalPath.slice(0, lastDot)} (conflict ${short} ${date})${originalPath.slice(lastDot)}`;
  }
  return `${originalPath} (conflict ${short} ${date})`;
}

function resolveAvailableConflictPath(db: AppDb, vaultId: string, originalPath: string, deviceId: string, ts: number) {
  const basePath = makeConflictPath(originalPath, deviceId, ts);
  let candidate = basePath;
  let suffix = 2;
  while (fileForPath(db, vaultId, candidate)) {
    const lastDot = basePath.lastIndexOf(".");
    const lastSlash = basePath.lastIndexOf("/");
    if (lastDot > lastSlash + 1) {
      candidate = `${basePath.slice(0, lastDot)} ${suffix}${basePath.slice(lastDot)}`;
    } else {
      candidate = `${basePath} ${suffix}`;
    }
    suffix += 1;
  }
  return candidate;
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

function recordConflict(
  db: AppDb,
  fileId: string,
  winnerRevisionId: string,
  loserRevisionId: string,
  conflictPath: string,
  now: number
) {
  db.insert(conflicts).values({
    id: newId("conflict"),
    fileId,
    winnerRevisionId,
    loserRevisionId,
    conflictPath,
    createdAt: now
  }).run();
}

function createServerConflictCopy(args: {
  db: AppDb;
  vaultId: string;
  sourcePath: string;
  blobHash: string;
  size: number | null;
  deviceId: string;
  ts: number;
}) {
  const conflictPath = resolveAvailableConflictPath(args.db, args.vaultId, args.sourcePath, args.deviceId, args.ts);
  const conflictFileId = ensureFile(args.db, args.vaultId, conflictPath, args.ts);
  const conflictHead = getHeadTs(args.db, conflictFileId);
  const conflictRevisionId = insertRevision(args.db, {
    fileId: conflictFileId,
    path: conflictPath,
    op: "upsert",
    blobHash: args.blobHash,
    size: args.size,
    deviceId: args.deviceId,
    ts: args.ts,
    prevRevisionId: conflictHead?.id || null
  });
  upsertFileHead(args.db, conflictFileId, conflictRevisionId, false, args.ts);
  insertEvent(args.db, args.vaultId, conflictFileId, conflictRevisionId, args.ts);
  return {
    conflictPath,
    conflictFileId,
    conflictRevisionId
  };
}

type OpResultStatus = "applied" | "duplicate" | "ignored" | "conflict";

export function applyOperations(vaultId: string, deviceId: string, ops: PushOperation[]) {
  const db = getOrmDb();
  const now = Date.now();
  const results: Array<{
    operationId: string;
    status: OpResultStatus;
    revisionId?: string;
    headRevisionId?: string;
    conflictPath?: string;
  }> = [];

  const appliedEvents: Array<{ fileId: string; revisionId: string }> = [];

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
      const p = normalizeSyncPath(raw.path);
      const setOpResult = (data: {
        status: OpResultStatus;
        revisionId?: string;
        headRevisionId?: string;
        conflictPath?: string;
      }) => {
        tx
          .update(syncOperations)
          .set({
            resultStatus: data.status,
            resultRevisionId: data.revisionId || null,
            resultHeadRevisionId: data.headRevisionId || null,
            resultConflictPath: data.conflictPath || null
          })
          .where(and(eq(syncOperations.deviceId, deviceId), eq(syncOperations.operationId, opId)))
          .run();
      };

      if (op === "rename") {
        const from = normalizeSyncPath(raw.prevPath || "");
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

        if (staleBase) {
          const rev = insertRevision(tx, {
            fileId: file.id,
            path: p,
            op: "rename",
            blobHash: null,
            size: null,
            deviceId,
            ts,
            prevRevisionId: raw.baseRevisionId || null
          });
          const cPath = makeConflictPath(from, deviceId, ts);
          recordConflict(tx, file.id, head!.id, rev, cPath, now);
          setOpResult({ status: "conflict", revisionId: rev, headRevisionId: head!.id, conflictPath: cPath });
          results.push({ operationId: opId, status: "conflict", revisionId: rev, headRevisionId: head!.id, conflictPath: cPath });
          continue;
        }

        if (!incomingWins) {
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
        appliedEvents.push({ fileId: file.id, revisionId: rev });
        setOpResult({ status: "applied", revisionId: rev, headRevisionId: rev });
        results.push({ operationId: opId, status: "applied", revisionId: rev });
        continue;
      }

      const fileId = ensureFile(tx, vaultId, p, ts);
      const head = getHeadTs(tx, fileId);
      const staleBase = Boolean(raw.baseRevisionId && head?.id && raw.baseRevisionId !== head.id);
      const incomingWins = !head || ts > head.ts || (ts === head.ts && deviceId > head.deviceId);

      if (staleBase) {
        if (op === "upsert" && raw.blobHash) {
          const conflictCopy = createServerConflictCopy({
            db: tx,
            vaultId,
            sourcePath: p,
            blobHash: raw.blobHash,
            size: raw.size || null,
            deviceId,
            ts
          });
          recordConflict(tx, fileId, head!.id, conflictCopy.conflictRevisionId, conflictCopy.conflictPath, now);
          appliedEvents.push({ fileId: conflictCopy.conflictFileId, revisionId: conflictCopy.conflictRevisionId });
          setOpResult({
            status: "conflict",
            revisionId: conflictCopy.conflictRevisionId,
            headRevisionId: head!.id,
            conflictPath: conflictCopy.conflictPath
          });
          results.push({
            operationId: opId,
            status: "conflict",
            revisionId: conflictCopy.conflictRevisionId,
            headRevisionId: head!.id,
            conflictPath: conflictCopy.conflictPath
          });
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
          prevRevisionId: raw.baseRevisionId || null
        });
        const cPath = resolveAvailableConflictPath(tx, vaultId, p, deviceId, ts);
        recordConflict(tx, fileId, head!.id, rev, cPath, now);
        setOpResult({ status: "conflict", revisionId: rev, headRevisionId: head!.id, conflictPath: cPath });
        results.push({ operationId: opId, status: "conflict", revisionId: rev, headRevisionId: head!.id, conflictPath: cPath });
        continue;
      }

      if (!incomingWins) {
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
      appliedEvents.push({ fileId, revisionId: rev });
      setOpResult({ status: "applied", revisionId: rev, headRevisionId: rev });
      results.push({ operationId: opId, status: "applied", revisionId: rev, headRevisionId: rev });
    }
  });

  for (const evt of appliedEvents) {
    syncEventBus.emit(vaultId, {
      fileId: evt.fileId,
      revisionId: evt.revisionId,
      sourceDeviceId: deviceId
    });
  }

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
