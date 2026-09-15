import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";
import type { SqlDriver } from "./sql.types.js";

/**
 * The table, verbatim from the SQLite Archive specification. Five columns,
 * `name` as the primary key and nothing more: any extra column, index or table
 * and other SQLAR tools may not recognise the archive.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS sqlar(
  name TEXT PRIMARY KEY,  -- name of the file
  mode INT,               -- access permissions
  mtime INT,              -- last modification time
  sz INT,                 -- original file size
  data BLOB               -- compressed content
)`;

// Full st_mode, type bits included, as archivers store it.
const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;

export type SqlarFilesApiOptions = {};

/** A FilesApi whose whole state is one SQLite Archive table. */
export class SqlarFilesApi implements FilesApi {
  readonly #sql: SqlDriver;

  constructor(sql: SqlDriver, _opts: SqlarFilesApiOptions = {}) {
    this.#sql = sql;
  }

  /** Creates the table if it is missing. Await it before any other call. */
  async init(): Promise<void> {
    await this.#sql.run(SCHEMA);
  }

  /** A missing path or a directory yields nothing; a file yields one chunk. */
  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    options.signal?.throwIfAborted();
    const name = toName(path);
    const rows = await this.#sql.all<StoredRow & { data: unknown }>(
      `SELECT ${ROW_COLUMNS}, data FROM sqlar WHERE name = ?`,
      name,
    );
    const row = rows[0];
    if (!row || kindOf(row) !== "file") return;

    const content = toBytes(row.data);
    const start = options.start ?? 0;
    const end = options.length === undefined ? content.byteLength : start + options.length;
    const chunk = content.subarray(start, Math.min(end, content.byteLength));
    if (chunk.byteLength > 0) yield chunk;
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const name = toName(path);
    const bytes = await concat(content);
    await this.mkdir(parentName(name));
    await this.#put(name, FILE_MODE, bytes.byteLength, bytes);
  }

  /** `sz = 0` with `data IS NULL` is the format's only marker for a directory. */
  async mkdir(path: string): Promise<void> {
    const name = toName(path);
    for (const dir of ancestorsAndSelf(name)) {
      if (!(await this.#has(dir))) await this.#put(dir, DIR_MODE, 0, null);
    }
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const name = toName(path);
    if (name === "") return { kind: "directory" };
    const row = await this.#row(name);
    if (row) return toStats(row);
    return (await this.#hasDescendants(name)) ? { kind: "directory" } : undefined;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stats(path)) !== undefined;
  }

  /**
   * SQLAR is a flat keyspace, so the tree is derived from names: a path that
   * only exists as a prefix of other names is yielded as a directory, once,
   * before anything under it.
   */
  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    const base = toName(path);
    if ((await this.stats(path))?.kind !== "directory") return;

    const range = descendants(base);
    const rows = await this.#sql.all<StoredRow>(
      `SELECT ${ROW_COLUMNS} FROM sqlar WHERE ${range.where} ORDER BY name`,
      ...range.params,
    );
    const prefixLength = base === "" ? 0 : base.length + 1;
    const seen = new Set<string>();

    for (const row of rows) {
      const segments = row.name.slice(prefixLength).split("/");
      const depth = options.recursive ? segments.length : 1;
      // Implicit directories on the way down to this row.
      for (let i = 1; i < Math.min(depth + 1, segments.length); i++) {
        const dirName = joinName(base, segments.slice(0, i).join("/"));
        if (seen.has(dirName)) continue;
        seen.add(dirName);
        yield { kind: "directory", name: segments[i - 1], path: `/${dirName}` };
      }
      if (segments.length > depth || seen.has(row.name)) continue;
      seen.add(row.name);
      yield { ...toStats(row), name: segments[segments.length - 1], path: `/${row.name}` };
    }
  }

  async remove(path: string): Promise<boolean> {
    const name = toName(path);
    const range = selfAndDescendants(name);
    const found = await this.#sql.all(
      `SELECT 1 FROM sqlar WHERE ${range.where} LIMIT 1`,
      ...range.params,
    );
    if (found.length === 0) return false;
    await this.#sql.run(`DELETE FROM sqlar WHERE ${range.where}`, ...range.params);
    return true;
  }

  /**
   * Rows are copied verbatim — mode, sz and the stored data — so a compressed
   * row is never inflated and deflated again. Only mtime is fresh.
   */
  async copy(source: string, target: string): Promise<boolean> {
    const from = toName(source);
    const to = toName(target);
    const range = selfAndDescendants(from);
    const rows = await this.#sql.all<StoredRow & { data: unknown }>(
      `SELECT ${ROW_COLUMNS}, data FROM sqlar WHERE ${range.where}`,
      ...range.params,
    );
    if (rows.length === 0) return false;

    await this.mkdir(parentName(to));
    for (const row of rows) {
      const name = joinName(to, row.name.slice(from.length).replace(/^\//, ""));
      await this.#put(
        name,
        row.mode,
        row.sz,
        row.dtype === "null" ? null : (row.data as Uint8Array),
      );
    }
    return true;
  }

  async move(source: string, target: string): Promise<boolean> {
    if (!(await this.copy(source, target))) return false;
    await this.remove(source);
    return true;
  }

  async #row(name: string): Promise<StoredRow | undefined> {
    const rows = await this.#sql.all<StoredRow>(
      `SELECT ${ROW_COLUMNS} FROM sqlar WHERE name = ?`,
      name,
    );
    return rows[0];
  }

  async #hasDescendants(name: string): Promise<boolean> {
    const range = descendants(name);
    const rows = await this.#sql.all(
      `SELECT 1 FROM sqlar WHERE ${range.where} LIMIT 1`,
      ...range.params,
    );
    return rows.length > 0;
  }

  async #has(name: string): Promise<boolean> {
    const rows = await this.#sql.all("SELECT 1 FROM sqlar WHERE name = ?", name);
    return rows.length > 0;
  }

  async #put(name: string, mode: number, sz: number, data: Uint8Array | string | null) {
    await this.#sql.run(
      `INSERT INTO sqlar (name, mode, mtime, sz, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         mode = excluded.mode, mtime = excluded.mtime, sz = excluded.sz, data = excluded.data`,
      name,
      mode,
      Math.floor(Date.now() / 1000), // SQLAR mtime is in seconds
      sz,
      data,
    );
  }
}

/** Row metadata without the content, so listings never load blobs. */
interface StoredRow {
  name: string;
  mode: number;
  mtime: number;
  sz: number;
  /** `typeof(data)`: "null" for directories, "blob" or "text" otherwise. */
  dtype: string;
}

const ROW_COLUMNS = "name, mode, mtime, sz, typeof(data) AS dtype";

function kindOf(row: StoredRow): "file" | "directory" {
  return row.sz === 0 && row.dtype === "null" ? "directory" : "file";
}

function toStats(row: StoredRow): FileStats {
  if (kindOf(row) === "directory") return { kind: "directory" };
  return { kind: "file", size: row.sz, lastModified: row.mtime * 1000 };
}

/**
 * Every name strictly under `name`, as a range on the primary key. `LIKE`
 * would be shorter and wrong: it is case-insensitive for ASCII, so "a/%" also
 * matches "A/x", and it cannot use the index. "0" is the character after "/".
 */
function descendants(name: string): { where: string; params: string[] } {
  if (name === "") return { where: "1", params: [] };
  return { where: "(name > ? AND name < ?)", params: [`${name}/`, `${name}0`] };
}

function selfAndDescendants(name: string): { where: string; params: string[] } {
  if (name === "") return descendants(name);
  const range = descendants(name);
  return { where: `(name = ? OR ${range.where})`, params: [name, ...range.params] };
}

/** A FilesApi path as a stored name: normalised, without the leading slash. The root is "". */
function toName(path: string): string {
  return normalizePath(path).slice(1);
}

function joinName(base: string, rest: string): string {
  if (base === "") return rest;
  return rest === "" ? base : `${base}/${rest}`;
}

function parentName(name: string): string {
  const i = name.lastIndexOf("/");
  return i === -1 ? "" : name.slice(0, i);
}

/** "a/b/c" → ["a", "a/b", "a/b/c"]; the root yields nothing. */
function ancestorsAndSelf(name: string): string[] {
  if (name === "") return [];
  const parts = name.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

async function concat(content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Blobs arrive as Uint8Array (node:sqlite), ArrayBuffer (Durable Objects) or number[] (D1). */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(0);
}
