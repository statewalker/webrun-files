import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";
import { toBytes } from "../bytes.js";
import type { SqlDriver, SqlStatement } from "../sql.types.js";
import { ByteReader, collectBlock } from "./byte-reader.js";
import { Sha256 } from "./sha256.js";
import { type StreamCodec, webDeflateCodec } from "./stream-codec.js";

const MiB = 1024 * 1024;
/** Rows on Durable Objects and D1 are capped at 2 MB; leave room for deflate's worst case. */
const MAX_BLOCK_SIZE_LIMIT = 1.5 * MiB;
const LIST_PAGE = 256;

export interface SqliteFilesApiOptions {
  /** Prefix of the three table names. Defaults to "fs_". */
  tablePrefix?: string;
  /**
   * Codec for new writes; `null` stores content uncompressed. Defaults to
   * {@link webDeflateCodec} where Compression Streams exist, uncompressed elsewhere.
   */
  compression?: StreamCodec | null;
  /**
   * Uncompressed bytes per block for new writes; only a file's last block is
   * shorter. An integer from 1 to 1.5 MiB, default 1 MiB. Each content records
   * the size it was written with, so changing this never affects existing files.
   */
  blockSize?: number;
}

interface EntryRow {
  fid: number | null;
  mtime: number;
  size: number | null;
  compression: string | null;
  block_size: number | null;
}

interface ListRow extends EntryRow {
  path: string;
}

/**
 * A FilesApi over three SQLite tables: paths point at immutable contents, and
 * a content is a sequence of bounded, optionally compressed blocks. Reads and
 * writes stream one block at a time, so no file is ever held whole and no row
 * outgrows the 2 MB limit of Durable Objects and D1.
 */
export class SqliteFilesApi implements FilesApi {
  readonly #sql: SqlDriver;
  readonly #codec: StreamCodec | null;
  readonly #blockSize: number;
  readonly #paths: string;
  readonly #files: string;
  readonly #blocks: string;
  readonly #prefix: string;

  constructor(sql: SqlDriver, opts: SqliteFilesApiOptions = {}) {
    const prefix = opts.tablePrefix ?? "fs_";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
      throw new Error(`SqliteFilesApi: tablePrefix must be a plain SQL identifier, got ${prefix}`);
    }
    this.#blockSize = opts.blockSize ?? MiB;
    if (
      !Number.isInteger(this.#blockSize) ||
      this.#blockSize < 1 ||
      this.#blockSize > MAX_BLOCK_SIZE_LIMIT
    ) {
      throw new Error(
        `SqliteFilesApi: blockSize must be an integer from 1 to ${MAX_BLOCK_SIZE_LIMIT}, got ${this.#blockSize}`,
      );
    }
    this.#sql = sql;
    this.#codec = opts.compression === undefined ? availableWebCodec() : opts.compression;
    this.#prefix = prefix;
    this.#paths = `${prefix}paths`;
    this.#files = `${prefix}files`;
    this.#blocks = `${prefix}blocks`;
  }

  /** Creates the tables and indexes if missing. Await it before any other call. */
  async init(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${this.#files}(
        fid INTEGER PRIMARY KEY,
        size INTEGER,
        compression TEXT NOT NULL,
        block_size INTEGER NOT NULL,
        hash TEXT,
        updated INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${this.#blocks}(
        fid INTEGER NOT NULL,
        shift INTEGER NOT NULL,
        block BLOB NOT NULL,
        PRIMARY KEY (fid, shift)
      ) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS ${this.#paths}(
        pid INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        fid INTEGER,
        mtime INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${this.#prefix}paths_fid ON ${this.#paths}(fid)`,
      `CREATE INDEX IF NOT EXISTS ${this.#prefix}files_hash ON ${this.#files}(hash, size)`,
    ];
    for (const statement of statements) await this.#sql.run(statement);
  }

  // ---------------------------------------------------------------- read

  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    options.signal?.throwIfAborted();
    const name = normalizePath(path);
    const entry = await this.#entry(name);
    if (!entry || entry.fid === null || entry.size === null) return;

    const start = Math.max(0, options.start ?? 0);
    const end = Math.min(
      entry.size,
      options.length === undefined ? entry.size : start + options.length,
    );
    if (start >= end) return;

    const { fid, size } = entry;
    const blockSize = entry.block_size ?? this.#blockSize;
    const decoder = this.#decoder(name, entry.compression ?? "none");

    // Fixed-size blocks: the block holding `start` is found by arithmetic, and
    // every block's uncompressed length is known before it is read.
    for (let shift = start - (start % blockSize); shift < end; shift += blockSize) {
      options.signal?.throwIfAborted();
      const block = await this.#block(fid, shift);
      if (!block) throw new Error(`sqlite-files: ${name} changed during read`);
      const expected = Math.min(blockSize, size - shift);
      const bytes = toBytes(block.block);

      const chunks = decoder ? decoder.decompress(once(bytes)) : once(bytes);
      let offset = shift;
      let stoppedEarly = false;
      for await (const chunk of chunks) {
        if (offset + chunk.length - shift > expected) {
          throw corruptBlock(name, shift, `at least ${offset + chunk.length - shift}`, expected);
        }
        const from = Math.max(0, start - offset);
        const to = Math.min(chunk.length, end - offset);
        offset += chunk.length;
        if (to > from) yield chunk.subarray(from, to);
        if (offset >= end) {
          stoppedEarly = true;
          break;
        }
      }
      if (!stoppedEarly && offset - shift !== expected) {
        throw corruptBlock(name, shift, offset - shift, expected);
      }
    }
  }

  // --------------------------------------------------------------- write

  /**
   * Streams the content into a new, invisible content row, one block per
   * transaction, then points the path at it in one transaction. Any failure
   * removes the pending content; a crash leaves it for {@link sweep}.
   */
  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const name = normalizePath(path);
    const compression = this.#codec?.name ?? "none";
    const created = await this.#sql.all<{ fid: number }>(
      `INSERT INTO ${this.#files}(size, compression, block_size, hash, updated)
       VALUES (NULL, ?, ?, NULL, ?) RETURNING fid`,
      compression,
      this.#blockSize,
      Date.now(),
    );
    const fid = created[0].fid;

    const limit = this.#blockSize;
    const reader = new ByteReader(content);
    const hash = new Sha256();
    try {
      let size = 0;
      for (;;) {
        const first = await reader.read(limit);
        if (!first) break;
        let raw = 0;
        // Pulls the source only while the block is being built: never ahead of storage.
        const pieces = async function* () {
          let piece: Uint8Array | undefined = first;
          while (piece) {
            hash.update(piece);
            raw += piece.length;
            yield piece;
            if (raw === limit) return;
            piece = await reader.read(limit - raw);
          }
        };
        const block = await collectBlock(this.#codec ? this.#codec.compress(pieces()) : pieces());
        const [alive] = await this.#sql.transaction([
          {
            sql: `UPDATE ${this.#files} SET updated = ? WHERE fid = ? AND size IS NULL`,
            params: [Date.now(), fid],
          },
          {
            sql: `INSERT INTO ${this.#blocks}(fid, shift, block)
                  SELECT ?, ?, ? WHERE EXISTS (${this.#pending("?")})`,
            params: [fid, size, block, fid],
          },
        ]);
        if (alive === 0) throw sweptDuringWrite(name);
        size += raw;
      }

      const previous = await this.#entry(name);
      const [finished] = await this.#sql.transaction(
        this.#finishWrite(name, fid, size, hash.digestHex(), compression, previous?.fid ?? null),
      );
      if (finished === 0) throw sweptDuringWrite(name);
    } catch (error) {
      try {
        await reader.close();
      } catch {}
      // Best effort, and never allowed to replace the error that brought us here —
      // including a synchronous throw from a synchronous driver.
      try {
        await this.#sql.transaction([
          { sql: `DELETE FROM ${this.#files} WHERE fid = ? AND size IS NULL`, params: [fid] },
          ...this.#deleteBlocksOfMissing(fid),
        ]);
      } catch {}
      throw error;
    }
  }

  /**
   * One transaction: finish the content, create the parents, point the path at
   * an identical content if one exists or else at this one, then collect this
   * content if it ended up unused and the path's previous content. Everything
   * after the first statement is conditioned on the content still existing, so
   * a swept write changes nothing.
   */
  #finishWrite(
    name: string,
    fid: number,
    size: number,
    digest: string,
    compression: string,
    previous: number | null,
  ): SqlStatement[] {
    const now = Date.now();
    const exists = `SELECT 1 FROM ${this.#files} WHERE fid = ?`;
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE ${this.#files} SET size = ?, hash = ?, updated = ? WHERE fid = ? AND size IS NULL`,
        params: [size, digest, now, fid],
      },
      ...ancestorsAndSelf(parentOf(name)).map((dir) => ({
        sql: `INSERT INTO ${this.#paths}(path, fid, mtime) SELECT ?, NULL, ? WHERE EXISTS (${exists})
              ON CONFLICT(path) DO NOTHING`,
        params: [dir, now, fid],
      })),
      {
        sql: `INSERT INTO ${this.#paths}(path, fid, mtime)
              SELECT ?, COALESCE((
                SELECT f.fid FROM ${this.#files} f
                WHERE f.hash = ? AND f.size = ? AND f.compression = ? AND f.block_size = ? AND f.fid <> ?
                ORDER BY f.fid LIMIT 1
              ), ?), ?
              WHERE EXISTS (${exists})
              ON CONFLICT(path) DO UPDATE SET fid = excluded.fid, mtime = excluded.mtime`,
        params: [name, digest, size, compression, this.#blockSize, fid, fid, now, fid],
      },
      ...this.#collect(fid),
    ];
    if (previous !== null && previous !== fid) statements.push(...this.#collect(previous));
    return statements;
  }

  async mkdir(path: string): Promise<void> {
    const now = Date.now();
    for (const dir of ancestorsAndSelf(normalizePath(path))) {
      await this.#sql.run(
        `INSERT INTO ${this.#paths}(path, fid, mtime) VALUES (?, NULL, ?) ON CONFLICT(path) DO NOTHING`,
        dir,
        now,
      );
    }
  }

  // --------------------------------------------------------------- stats

  async stats(path: string): Promise<FileStats | undefined> {
    const name = normalizePath(path);
    if (name === "/") return { kind: "directory" };
    const entry = await this.#entry(name);
    return entry && toStats(entry);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stats(path)) !== undefined;
  }

  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    const base = normalizePath(path);
    if ((await this.stats(base))?.kind !== "directory") return;

    const range = descendants(base);
    const prefixLength = base === "/" ? 1 : base.length + 1;
    const directOnly = options.recursive ? "" : "AND instr(substr(p.path, ?), '/') = 0";
    let cursor = "";
    for (;;) {
      const params: unknown[] = [...range.params, cursor];
      if (!options.recursive) params.push(prefixLength + 1);
      const rows = await this.#sql.all<ListRow>(
        `SELECT p.path, p.fid, p.mtime, f.size, f.compression, f.block_size
         FROM ${this.#paths} p LEFT JOIN ${this.#files} f ON f.fid = p.fid
         WHERE ${range.where} AND p.path > ? ${directOnly}
         ORDER BY p.path LIMIT ${LIST_PAGE}`,
        ...params,
      );
      for (const row of rows) {
        const stats = toStats(row);
        if (stats)
          yield { ...stats, name: row.path.slice(row.path.lastIndexOf("/") + 1), path: row.path };
      }
      if (rows.length < LIST_PAGE) return;
      cursor = rows[rows.length - 1].path;
    }
  }

  // ------------------------------------------------------------- mutation

  async remove(path: string): Promise<boolean> {
    const counts = await this.#sql.transaction(this.#removeTree(normalizePath(path)));
    return counts[counts.length - 1] > 0;
  }

  /**
   * Deletes available contents and blocks referenced only from inside the tree, then the tree's
   * path rows. Set-based, so it needs no ids read beforehand. `guard` conditions every statement.
   */
  #removeTree(path: string, guard: Guard = NO_GUARD): SqlStatement[] {
    const inP = selfAndDescendants(path, "p");
    const inQ = selfAndDescendants(path, "q");
    const referenced = `SELECT p.fid FROM ${this.#paths} p WHERE ${inP.where}`;
    return [
      {
        sql: `DELETE FROM ${this.#files} WHERE size IS NOT NULL
              AND fid IN (${referenced})
              AND NOT EXISTS (
                SELECT 1 FROM ${this.#paths} q WHERE q.fid = ${this.#files}.fid AND NOT ${inQ.where}
              ) ${guard.sql}`,
        params: [...inP.params, ...inQ.params, ...guard.params],
      },
      {
        sql: `DELETE FROM ${this.#blocks} WHERE fid IN (${referenced})
              AND NOT EXISTS (SELECT 1 FROM ${this.#files} f WHERE f.fid = ${this.#blocks}.fid)
              ${guard.sql}`,
        params: [...inP.params, ...guard.params],
      },
      {
        sql: `DELETE FROM ${this.#paths} AS p WHERE ${inP.where} ${guard.sql}`,
        params: [...inP.params, ...guard.params],
      },
    ];
  }

  async copy(source: string, target: string): Promise<boolean> {
    return this.#transfer(source, target, "copy");
  }

  async move(source: string, target: string): Promise<boolean> {
    return this.#transfer(source, target, "move");
  }

  /**
   * One transaction: replace the target's subtree, create its parents, then copy
   * or rename. Everything before the last statement is conditioned on the source
   * existing, so a source that vanished leaves the target untouched.
   */
  async #transfer(source: string, target: string, mode: "copy" | "move"): Promise<boolean> {
    const from = normalizePath(source);
    const to = normalizePath(target);
    if (from === to) return this.exists(from);
    if (isInside(to, from) || isInside(from, to)) {
      throw new Error(`sqlite-files: cannot ${mode} ${from} to ${to}: one contains the other`);
    }

    const range = selfAndDescendants(from, "p");
    const inS = selfAndDescendants(from, "s");
    const guard: Guard = {
      sql: `AND EXISTS (SELECT 1 FROM ${this.#paths} s WHERE ${inS.where})`,
      params: inS.params,
    };
    const now = Date.now();
    const statements: SqlStatement[] = [
      ...this.#removeTree(to, guard),
      ...ancestorsAndSelf(parentOf(to)).map((dir) => ({
        sql: `INSERT INTO ${this.#paths}(path, fid, mtime) SELECT ?, NULL, ? WHERE 1 ${guard.sql}
              ON CONFLICT(path) DO NOTHING`,
        params: [dir, now, ...guard.params],
      })),
      mode === "copy"
        ? {
            sql: `INSERT INTO ${this.#paths}(path, fid, mtime)
                  SELECT ? || substr(p.path, ?), p.fid, ? FROM ${this.#paths} p WHERE ${range.where}`,
            params: [to, from.length + 1, now, ...range.params],
          }
        : {
            sql: `UPDATE ${this.#paths} AS p SET path = ? || substr(p.path, ?), mtime = ?
                  WHERE ${range.where}`,
            params: [to, from.length + 1, now, ...range.params],
          },
    ];
    const counts = await this.#sql.transaction(statements);
    return counts[counts.length - 1] > 0;
  }

  /**
   * Deletes, in one transaction, every content not updated for `olderThan`
   * milliseconds that is still pending or that no path references, with its
   * blocks. Returns how many contents were deleted.
   *
   * A write refreshes its pending content with every block, so only a write
   * stalled longer than `olderThan` can be swept — and it then fails instead of
   * pointing a path at missing content. Never runs on its own.
   */
  async sweep(options: { olderThan: number }): Promise<number> {
    const { olderThan } = options;
    if (!(Number.isFinite(olderThan) && olderThan >= 0)) {
      throw new Error(
        `SqliteFilesApi.sweep: olderThan must be a finite number >= 0, got ${olderThan}`,
      );
    }
    const cutoff = Date.now() - olderThan;
    // A pending content is never referenced — a path only points at a content in
    // the transaction that finishes it — so "unreferenced" covers both cases.
    const eligible = `f.updated < ? AND NOT EXISTS (
      SELECT 1 FROM ${this.#paths} p WHERE p.fid = f.fid
    )`;
    const [, contents] = await this.#sql.transaction([
      {
        sql: `DELETE FROM ${this.#blocks} WHERE fid IN (SELECT f.fid FROM ${this.#files} f WHERE ${eligible})`,
        params: [cutoff],
      },
      { sql: `DELETE FROM ${this.#files} AS f WHERE ${eligible}`, params: [cutoff] },
    ]);
    return contents;
  }

  // -------------------------------------------------------------- private

  async #entry(name: string): Promise<EntryRow | undefined> {
    const rows = await this.#sql.all<EntryRow>(
      `SELECT p.fid, p.mtime, f.size, f.compression, f.block_size
       FROM ${this.#paths} p LEFT JOIN ${this.#files} f ON f.fid = p.fid
       WHERE p.path = ?`,
      name,
    );
    return rows[0];
  }

  #decoder(name: string, compression: string): StreamCodec | null {
    if (compression === "none") return null;
    if (this.#codec?.name === compression) return this.#codec;
    if (compression === "deflate") {
      const web = availableWebCodec();
      if (web) return web;
    }
    throw new Error(
      `sqlite-files: ${name} is compressed with ${compression}, and no codec reads it`,
    );
  }

  async #block(fid: number, shift: number) {
    const rows = await this.#sql.all<{ shift: number; block: unknown }>(
      `SELECT shift, block FROM ${this.#blocks} WHERE fid = ? AND shift = ?`,
      fid,
      shift,
    );
    return rows[0];
  }

  /** A subquery selecting the content `fid` while it is still pending. */
  #pending(fid: string): string {
    return `SELECT 1 FROM ${this.#files} WHERE fid = ${fid} AND size IS NULL`;
  }

  /**
   * Delete a finished content no path references, then its blocks. Inside a
   * transaction the reference check and the delete cannot be separated by a
   * write that shares the content.
   */
  #collect(fid: number): SqlStatement[] {
    return [
      {
        sql: `DELETE FROM ${this.#files} WHERE fid = ? AND size IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM ${this.#paths} WHERE fid = ?)`,
        params: [fid, fid],
      },
      ...this.#deleteBlocksOfMissing(fid),
    ];
  }

  #deleteBlocksOfMissing(fid: number): SqlStatement[] {
    return [
      {
        sql: `DELETE FROM ${this.#blocks} WHERE fid = ?
              AND NOT EXISTS (SELECT 1 FROM ${this.#files} WHERE fid = ?)`,
        params: [fid, fid],
      },
    ];
  }
}

interface Guard {
  sql: string;
  params: unknown[];
}

const NO_GUARD: Guard = { sql: "", params: [] };

function sweptDuringWrite(name: string): Error {
  return new Error(`sqlite-files: ${name} content was swept during write`);
}

function corruptBlock(name: string, shift: number, holds: number | string, expected: number) {
  return new Error(
    `sqlite-files: ${name} block at ${shift} holds ${holds} bytes, expected ${expected}`,
  );
}

function availableWebCodec(): StreamCodec | null {
  return typeof CompressionStream === "undefined" ? null : webDeflateCodec();
}

function toStats(row: EntryRow): FileStats | undefined {
  if (row.fid === null) return { kind: "directory" };
  if (row.size === null) return undefined;
  return { kind: "file", size: row.size, lastModified: row.mtime };
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Rows strictly under `path` as a range on the unique index (case-sensitive, unlike LIKE). */
function descendants(path: string, alias = "p"): { where: string; params: string[] } {
  if (path === "/") return { where: "1", params: [] };
  return { where: `(${alias}.path > ? AND ${alias}.path < ?)`, params: [`${path}/`, `${path}0`] };
}

function selfAndDescendants(path: string, alias = "p"): { where: string; params: string[] } {
  if (path === "/") return descendants(path, alias);
  const range = descendants(path, alias);
  return { where: `(${alias}.path = ? OR ${range.where})`, params: [path, ...range.params] };
}

function isInside(path: string, ancestor: string): boolean {
  return ancestor === "/" ? path !== "/" : path.startsWith(`${ancestor}/`);
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** "/a/b" → ["/a", "/a/b"]; the root yields nothing. */
function ancestorsAndSelf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
}
