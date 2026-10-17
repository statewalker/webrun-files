import type { Db } from "@statewalker/db-api";
import { type Codec, SqlarFilesApi } from "../src/index.js";
import { type Driver, openDb } from "./open-db.js";

/** A fresh in-memory archive, with its Db for inspecting the table directly. */
export async function newArchive(opts: { codec?: Codec; db?: Db; driver?: Driver } = {}) {
  const db = opts.db ?? (await openDb(opts.driver));
  const files = new SqlarFilesApi(db, { codec: opts.codec });
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
export async function rawRow(db: Db, name: string): Promise<RawRow | undefined> {
  const rows = await db.query<RawRow>(
    "SELECT name, mode, mtime, sz, typeof(data) AS dtype, length(data) AS len, data FROM sqlar WHERE name = ?",
    [name],
  );
  return rows[0];
}

export async function rawNames(db: Db): Promise<string[]> {
  const rows = await db.query<{ name: string }>("SELECT name FROM sqlar ORDER BY name");
  return rows.map((r) => r.name);
}
