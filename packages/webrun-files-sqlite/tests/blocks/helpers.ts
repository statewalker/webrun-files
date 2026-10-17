import type { Db } from "@statewalker/db-api";
import { SQLITE_TRANSACTION, type SqliteTransactionHook } from "@statewalker/db-sqlite";
import { SqliteFilesApi, type SqliteFilesApiOptions } from "../../src/index.js";
import { type Driver, openDb } from "../open-db.js";

/** A fresh in-memory SqliteFilesApi, with its Db for inspecting the tables directly. */
export async function newFiles(
  opts: SqliteFilesApiOptions & { db?: Db; driver?: Driver; spy?: Spy } = {},
) {
  const { db: given, driver, spy, ...options } = opts;
  const db = given ?? (await openDb(driver));
  const files = new SqliteFilesApi(spy ? spyDb(db, spy) : db, options);
  await files.init();
  return { db, files };
}

export interface Spy {
  /** Sees every query, inside a transaction or not; `next` runs it. */
  query?(
    sql: string,
    params: unknown[],
    next: () => Promise<unknown[]>,
    inTransaction: boolean,
  ): Promise<unknown[]>;
  /** Runs before each transaction starts. */
  before?(): void | Promise<void>;
  /** Runs inside each transaction after its statements; a throw rolls the transaction back. */
  after?(tx: Db): void | Promise<void>;
}

/**
 * A Db that reports to `spy`. A plain wrapper would lose db-sqlite's
 * transaction hook, so this one re-exposes it and spies on the transaction's Db too.
 */
export function spyDb(db: Db, spy: Spy): Db {
  const wrap = (inner: Db, inTransaction: boolean): Db => ({
    query: <T>(sql: string, params: unknown[] = []) =>
      (spy.query
        ? spy.query(sql, params, () => inner.query(sql, params), inTransaction)
        : inner.query(sql, params)) as Promise<T[]>,
    exec: (sql) => inner.exec(sql),
    close: () => inner.close(),
  });
  const hooked = db as unknown as Record<symbol, SqliteTransactionHook>;
  const transaction: SqliteTransactionHook = async (cb) => {
    await spy.before?.();
    return hooked[SQLITE_TRANSACTION](async (tx) => {
      const result = await cb(wrap(tx, true));
      await spy.after?.(tx);
      return result;
    });
  };
  return Object.assign(wrap(db, false), { [SQLITE_TRANSACTION]: transaction });
}

export interface BlockRow {
  fid: number;
  shift: number;
  len: number;
  block: Uint8Array;
}

export function blocksOf(db: Db, fid: number, prefix = "fs_"): Promise<BlockRow[]> {
  return db.query<BlockRow>(
    `SELECT fid, shift, length(block) AS len, block FROM ${prefix}blocks WHERE fid = ? ORDER BY shift`,
    [fid],
  );
}

export interface PathRow {
  pid: number;
  path: string;
  fid: number | null;
  mtime: number;
}

export async function pathRow(db: Db, path: string, prefix = "fs_"): Promise<PathRow | undefined> {
  return (await db.query<PathRow>(`SELECT * FROM ${prefix}paths WHERE path = ?`, [path]))[0];
}

export interface FileRow {
  fid: number;
  size: number | null;
  compression: string;
  block_size: number;
  hash: string | null;
  updated: number;
}

export async function fileRow(db: Db, fid: number, prefix = "fs_"): Promise<FileRow | undefined> {
  return (await db.query<FileRow>(`SELECT * FROM ${prefix}files WHERE fid = ?`, [fid]))[0];
}

export async function count(db: Db, table: string): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0].n;
}

/** Every row of the three tables, blocks summarised, for before/after comparisons. */
export async function snapshot(db: Db, prefix = "fs_") {
  return {
    paths: await db.query(`SELECT path, fid FROM ${prefix}paths ORDER BY path`),
    files: await db.query(
      `SELECT fid, size, compression, block_size, hash FROM ${prefix}files ORDER BY fid`,
    ),
    blocks: await db.query(
      `SELECT fid, shift, length(block) AS len FROM ${prefix}blocks ORDER BY fid, shift`,
    ),
  };
}
