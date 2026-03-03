import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { AppDb } from "#app/db/client";
import { createDrizzleClient } from "#app/db/client";
import { resolveDataPaths } from "#app/utils/paths";

let sqlite: Database.Database | null = null;
let orm: AppDb | null = null;

function tableExists(database: Database.Database, tableName: string) {
  const row = database
    .prepare(`SELECT 1 as ok FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`)
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function findMigrationsFolder() {
  const candidates = [
    path.resolve(process.cwd(), "server/drizzle"),
    path.resolve(process.cwd(), "drizzle")
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function bootstrapLegacyAsBaseline(database: Database.Database, migrationsFolder: string) {
  const hasLegacySchema = tableExists(database, "vaults") && tableExists(database, "devices");
  const hasDrizzleMeta = tableExists(database, "__drizzle_migrations");
  if (!hasLegacySchema || hasDrizzleMeta) {
    return;
  }

  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return;
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ tag: string; when: number }>;
  };
  const latest = journal.entries?.at(-1);
  if (!latest) {
    return;
  }

  const sqlPath = path.join(migrationsFolder, `${latest.tag}.sql`);
  if (!fs.existsSync(sqlPath)) {
    return;
  }

  const hash = createHash("sha256").update(fs.readFileSync(sqlPath, "utf8")).digest("hex");
  database.exec(
    `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash text NOT NULL,
      created_at numeric
    );`
  );
  database
    .prepare(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`)
    .run(hash, latest.when);
}

export function getSqliteDb() {
  if (sqlite) {
    return sqlite;
  }

  const { dbPath } = resolveDataPaths();
  sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  return sqlite;
}

export function getOrmDb() {
  if (orm) {
    return orm;
  }

  const sqliteDb = getSqliteDb();
  const migrationsFolder = findMigrationsFolder();
  bootstrapLegacyAsBaseline(sqliteDb, migrationsFolder);
  migrate(createDrizzleClient(sqliteDb), { migrationsFolder });
  orm = createDrizzleClient(sqliteDb);
  return orm;
}
