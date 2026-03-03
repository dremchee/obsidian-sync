import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#app/db/schema";

export type AppDb = BetterSQLite3Database<typeof schema>;

export function createDrizzleClient(sqlite: Database.Database): AppDb {
  return drizzle(sqlite, { schema });
}
