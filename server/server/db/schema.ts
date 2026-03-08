import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const vaults = sqliteTable("vaults", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  passphraseHash: text("passphrase_hash"),
  createdAt: integer("created_at", { mode: "number" }).notNull()
}, (t) => ({
  nameIdx: uniqueIndex("vaults_name_idx").on(t.name)
}));

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  vaultId: text("vault_id").notNull().references(() => vaults.id),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  revokedAt: integer("revoked_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull()
});

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  vaultId: text("vault_id").notNull().references(() => vaults.id),
  path: text("path").notNull(),
  headRevisionId: text("head_revision_id"),
  deleted: integer("deleted", { mode: "number" }).notNull().default(0),
  updatedAt: integer("updated_at", { mode: "number" }).notNull()
});

export const fileRevisions = sqliteTable("file_revisions", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  path: text("path").notNull(),
  op: text("op").notNull(),
  blobHash: text("blob_hash"),
  size: integer("size", { mode: "number" }),
  deviceId: text("device_id").notNull().references(() => devices.id),
  ts: integer("ts", { mode: "number" }).notNull(),
  prevRevisionId: text("prev_revision_id")
});

export const syncCursors = sqliteTable("sync_cursors", {
  deviceId: text("device_id").primaryKey().references(() => devices.id),
  cursorTs: integer("cursor_ts", { mode: "number" }).notNull().default(0),
  lastEventId: integer("last_event_id", { mode: "number" }).notNull().default(0)
});

export const conflicts = sqliteTable("conflicts", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  winnerRevisionId: text("winner_revision_id").notNull(),
  loserRevisionId: text("loser_revision_id").notNull(),
  conflictPath: text("conflict_path").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull()
});

export const events = sqliteTable("events", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  vaultId: text("vault_id").notNull().references(() => vaults.id),
  fileId: text("file_id").notNull().references(() => files.id),
  revisionId: text("revision_id").notNull(),
  ts: integer("ts", { mode: "number" }).notNull()
});

export const syncOperations = sqliteTable("sync_operations", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  deviceId: text("device_id").notNull().references(() => devices.id),
  operationId: text("operation_id").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  resultStatus: text("result_status"),
  resultRevisionId: text("result_revision_id"),
  resultHeadRevisionId: text("result_head_revision_id"),
  resultConflictPath: text("result_conflict_path")
});
