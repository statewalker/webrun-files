import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";
import { toBytes } from "../bytes.js";
import type { SqlDriver } from "../sql.types.js";
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
        hash TEXT
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

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const name = normalizePath(path);
    const compression = this.#codec?.name ?? "none";
    const created = await this.#sql.all<{ fid: number }>(
      `INSERT INTO ${this.#files}(size, compression, block_size, hash)
       VALUES (NULL, ?, ?, NULL) RETURNING fid`,
      compression,
      this.#blockSize,
    );
    const fid = created[0].fid;

    const limit = this.#blockSize;
    const reader = new ByteReader(content);
    const hash = new Sha256();
    let size = 0;
    let digest: string;
    try {
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
        await this.#sql.run(
          `INSERT INTO ${this.#blocks}(fid, shift, block) VALUES (?, ?, ?)`,
          fid,
          size,
          block,
        );
        size += raw;
      }
      digest = hash.digestHex();
      await this.#sql.run(
        `UPDATE ${this.#files} SET size = ?, hash = ? WHERE fid = ?`,
        size,
        digest,
        fid,
      );
    } catch (error) {
      await reader.close().catch(() => {});
      await this.#deleteContent(fid);
      throw error;
    }

    await this.mkdir(parentOf(name));
    const previous = await this.#entry(name);
    const now = Date.now();
    const shared = await this.#sql.all<{ fid: number }>(
      `INSERT INTO ${this.#paths}(path, fid, mtime)
         SELECT ?, fid, ? FROM ${this.#files}
         WHERE hash = ? AND size = ? AND compression = ? AND block_size = ? AND fid <> ?
         ORDER BY fid LIMIT 1
       ON CONFLICT(path) DO UPDATE SET fid = excluded.fid, mtime = excluded.mtime
       RETURNING fid`,
      name,
      now,
      digest,
      size,
      compression,
      this.#blockSize,
      fid,
    );
    if (shared.length > 0) {
      await this.#deleteContent(fid);
    } else {
      await this.#sql.run(
        `INSERT INTO ${this.#paths}(path, fid, mtime) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET fid = excluded.fid, mtime = excluded.mtime`,
        name,
        fid,
        now,
      );
    }
    const current = shared[0]?.fid ?? fid;
    if (previous?.fid != null && previous.fid !== current) await this.#collect(previous.fid);
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
    const range = selfAndDescendants(normalizePath(path));
    const found = await this.#sql.all(
      `SELECT 1 FROM ${this.#paths} p WHERE ${range.where} LIMIT 1`,
      ...range.params,
    );
    if (found.length === 0) return false;
    const fids = await this.#sql.all<{ fid: number }>(
      `SELECT DISTINCT fid FROM ${this.#paths} p WHERE ${range.where} AND fid IS NOT NULL`,
      ...range.params,
    );
    await this.#sql.run(`DELETE FROM ${this.#paths} AS p WHERE ${range.where}`, ...range.params);
    for (const { fid } of fids) await this.#collect(fid);
    return true;
  }

  async copy(source: string, target: string): Promise<boolean> {
    return this.#transfer(source, target, "copy");
  }

  async move(source: string, target: string): Promise<boolean> {
    return this.#transfer(source, target, "move");
  }

  async #transfer(source: string, target: string, mode: "copy" | "move"): Promise<boolean> {
    const from = normalizePath(source);
    const to = normalizePath(target);
    const range = selfAndDescendants(from);
    const found = await this.#sql.all(
      `SELECT 1 FROM ${this.#paths} p WHERE ${range.where} LIMIT 1`,
      ...range.params,
    );
    if (found.length === 0) return false;
    if (from === to) return true;
    if (isInside(to, from) || isInside(from, to)) {
      throw new Error(`sqlite-files: cannot ${mode} ${from} to ${to}: one contains the other`);
    }

    await this.remove(to);
    await this.mkdir(parentOf(to));
    const now = Date.now();
    if (mode === "copy") {
      await this.#sql.run(
        `INSERT INTO ${this.#paths}(path, fid, mtime)
         SELECT ? || substr(p.path, ?), p.fid, ? FROM ${this.#paths} p WHERE ${range.where}`,
        to,
        from.length + 1,
        now,
        ...range.params,
      );
    } else {
      await this.#sql.run(
        `UPDATE ${this.#paths} AS p SET path = ? || substr(p.path, ?), mtime = ? WHERE ${range.where}`,
        to,
        from.length + 1,
        now,
        ...range.params,
      );
    }
    return true;
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

  /**
   * Delete a content no path references. Each step is one statement, so a
   * concurrent write sharing it either lands first (and nothing is deleted)
   * or finds no row to share. `size IS NOT NULL` spares contents being written.
   */
  async #collect(fid: number): Promise<void> {
    await this.#sql.run(
      `DELETE FROM ${this.#files} WHERE fid = ? AND size IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${this.#paths} WHERE fid = ?)`,
      fid,
      fid,
    );
    await this.#sql.run(
      `DELETE FROM ${this.#blocks} WHERE fid = ?
         AND NOT EXISTS (SELECT 1 FROM ${this.#files} WHERE fid = ?)`,
      fid,
      fid,
    );
  }

  /** Unconditional: only for a content this call created and nothing points at. */
  async #deleteContent(fid: number): Promise<void> {
    await this.#sql.run(`DELETE FROM ${this.#files} WHERE fid = ?`, fid);
    await this.#sql.run(`DELETE FROM ${this.#blocks} WHERE fid = ?`, fid);
  }
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

/** Rows strictly under `path`, as a range on the unique index (case-sensitive, unlike LIKE). */
function descendants(path: string): { where: string; params: string[] } {
  if (path === "/") return { where: "1", params: [] };
  return { where: "(p.path > ? AND p.path < ?)", params: [`${path}/`, `${path}0`] };
}

function selfAndDescendants(path: string): { where: string; params: string[] } {
  if (path === "/") return descendants(path);
  const range = descendants(path);
  return { where: `(p.path = ? OR ${range.where})`, params: [path, ...range.params] };
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
