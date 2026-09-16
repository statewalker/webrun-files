import { DatabaseSync } from "node:sqlite";
import {
  NodeSqlDriver,
  type SqlDriver,
  SqliteFilesApi,
  type SqliteFilesApiOptions,
} from "../../src/index.js";

/** A fresh in-memory SqliteFilesApi over node:sqlite, with the raw handle for inspection. */
export async function newFiles(
  opts: SqliteFilesApiOptions & { db?: DatabaseSync; wrap?: (driver: SqlDriver) => SqlDriver } = {},
) {
  const { db: given, wrap, ...options } = opts;
  const db = given ?? new DatabaseSync(":memory:");
  const base = new NodeSqlDriver(db);
  const files = new SqliteFilesApi(wrap ? wrap(base) : base, options);
  await files.init();
  return { db, files };
}

export interface BlockRow {
  fid: number;
  shift: number;
  len: number;
  block: Uint8Array;
}

export function blocksOf(db: DatabaseSync, fid: number, prefix = "fs_"): BlockRow[] {
  return db
    .prepare(
      `SELECT fid, shift, length(block) AS len, block FROM ${prefix}blocks WHERE fid = ? ORDER BY shift`,
    )
    .all(fid) as unknown as BlockRow[];
}

export interface PathRow {
  pid: number;
  path: string;
  fid: number | null;
  mtime: number;
}

export function pathRow(db: DatabaseSync, path: string, prefix = "fs_"): PathRow | undefined {
  return db.prepare(`SELECT * FROM ${prefix}paths WHERE path = ?`).get(path) as unknown as
    | PathRow
    | undefined;
}

export interface FileRow {
  fid: number;
  size: number | null;
  compression: string;
  block_size: number;
  hash: string | null;
}

export function fileRow(db: DatabaseSync, fid: number, prefix = "fs_"): FileRow | undefined {
  return db.prepare(`SELECT * FROM ${prefix}files WHERE fid = ?`).get(fid) as unknown as
    | FileRow
    | undefined;
}

export function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
