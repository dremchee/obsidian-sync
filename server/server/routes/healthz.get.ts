import { defineEventHandler } from "h3";
import { sql } from "drizzle-orm";
import { getOrmDb } from "#app/utils/db";

export default defineEventHandler(async () => {
  const db = getOrmDb();
  const row = db.get<{ ok: number }>(sql`select 1 as ok`);
  return {
    status: row?.ok === 1 ? "ok" : "fail",
    time: Date.now()
  };
});
