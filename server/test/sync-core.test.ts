import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDrizzleClient } from "../server/db/client";
import { devices, events, fileRevisions, files, vaults } from "../server/db/schema";

const mocks = vi.hoisted(() => ({
  getOrmDb: vi.fn(),
  emit: vi.fn(),
  newIdCounter: 0
}));

vi.mock("#app/utils/db", () => ({
  getOrmDb: mocks.getOrmDb
}));

vi.mock("#app/utils/event-bus", () => ({
  syncEventBus: {
    emit: mocks.emit
  }
}));

vi.mock("#app/utils/auth", () => ({
  newId: (prefix: string) => {
    mocks.newIdCounter += 1;
    return `${prefix}_${mocks.newIdCounter}`;
  }
}));

import { applyOperations } from "#app/utils/sync-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../drizzle");

function makeTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = createDrizzleClient(sqlite);
  migrate(db, { migrationsFolder });
  return { sqlite, db };
}

function seedVault(db: ReturnType<typeof createDrizzleClient>) {
  db.insert(vaults).values({
    id: "vault_1",
    name: "Test Vault",
    passphraseHash: null,
    createdAt: 1
  }).run();
  db.insert(devices).values([
    {
      id: "device_a",
      vaultId: "vault_1",
      name: "Device A",
      apiKeyHash: "a",
      createdAt: 1,
      revokedAt: null
    },
    {
      id: "device_b",
      vaultId: "vault_1",
      name: "Device B",
      apiKeyHash: "b",
      createdAt: 1,
      revokedAt: null
    }
  ]).run();
}

describe("sync-core conflicts", () => {
  beforeEach(() => {
    mocks.getOrmDb.mockReset();
    mocks.emit.mockReset();
    mocks.newIdCounter = 0;
  });

  it("creates a server-side conflict copy for stale upserts", () => {
    const { sqlite, db } = makeTestDb();
    mocks.getOrmDb.mockReturnValue(db);
    seedVault(db);

    const first = applyOperations("vault_1", "device_a", [{
      operationId: "op_1",
      op: "upsert",
      path: "Notes/Test.md",
      blobHash: "a".repeat(64),
      size: 12,
      clientTs: 100
    }]);
    expect(first[0]?.status).toBe("applied");

    const conflicted = applyOperations("vault_1", "device_b", [{
      operationId: "op_2",
      op: "upsert",
      path: "Notes/Test.md",
      blobHash: "b".repeat(64),
      size: 24,
      clientTs: 101,
      baseRevisionId: "stale_revision"
    }]);

    expect(conflicted[0]?.status).toBe("conflict");
    expect(conflicted[0]?.conflictPath).toContain("Notes/Test");

    const conflictFile = db
      .select()
      .from(files)
      .where(eq(files.path, conflicted[0]!.conflictPath!))
      .get();
    expect(conflictFile).toBeTruthy();

    const conflictRevision = db
      .select()
      .from(fileRevisions)
      .where(eq(fileRevisions.id, conflictFile!.headRevisionId!))
      .get();
    expect(conflictRevision?.blobHash).toBe("b".repeat(64));
    expect(conflictRevision?.deviceId).toBe("device_b");

    const allEvents = db.select().from(events).all();
    expect(allEvents).toHaveLength(2);
    expect(mocks.emit).toHaveBeenCalledTimes(2);

    sqlite.close();
  });

  it("allocates distinct paths for repeated conflict copies", () => {
    const { sqlite, db } = makeTestDb();
    mocks.getOrmDb.mockReturnValue(db);
    seedVault(db);

    applyOperations("vault_1", "device_a", [{
      operationId: "op_1",
      op: "upsert",
      path: "Notes/Test.md",
      blobHash: "a".repeat(64),
      size: 12,
      clientTs: 100
    }]);

    const firstConflict = applyOperations("vault_1", "device_b", [{
      operationId: "op_2",
      op: "upsert",
      path: "Notes/Test.md",
      blobHash: "b".repeat(64),
      size: 24,
      clientTs: 101,
      baseRevisionId: "stale_revision_1"
    }]);

    const secondConflict = applyOperations("vault_1", "device_b", [{
      operationId: "op_3",
      op: "upsert",
      path: "Notes/Test.md",
      blobHash: "c".repeat(64),
      size: 48,
      clientTs: 102,
      baseRevisionId: "stale_revision_2"
    }]);

    expect(firstConflict[0]?.conflictPath).not.toBe(secondConflict[0]?.conflictPath);

    const paths = db.select({ path: files.path }).from(files).all().map((row) => row.path);
    expect(paths).toContain(firstConflict[0]?.conflictPath);
    expect(paths).toContain(secondConflict[0]?.conflictPath);

    sqlite.close();
  });
});
