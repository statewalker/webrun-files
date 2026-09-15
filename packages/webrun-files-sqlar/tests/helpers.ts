import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver, SqlarFilesApi } from "../src/index.js";

/** A fresh in-memory archive over node:sqlite, with the raw handle for inspection. */
export async function newArchive(opts: { codec?: unknown; db?: DatabaseSync } = {}) {
  const db = opts.db ?? new DatabaseSync(":memory:");
  const files = new SqlarFilesApi(new NodeSqlDriver(db), { codec: opts.codec } as never);
  await files.init();
  return { db, files };
}

export interface RawRow {
  name: string;
  mode: number;
  mtime: number;
  sz: number;
  dtype: string;
  len: number | null;
  data: unknown;
}

/** The stored row for `name`, read with plain SQL — independent of the adapter. */
export function rawRow(db: DatabaseSync, name: string): RawRow | undefined {
  return db
    .prepare(
      "SELECT name, mode, mtime, sz, typeof(data) AS dtype, length(data) AS len, data FROM sqlar WHERE name = ?",
    )
    .get(name) as RawRow | undefined;
}

export function rawNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlar ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );
}
