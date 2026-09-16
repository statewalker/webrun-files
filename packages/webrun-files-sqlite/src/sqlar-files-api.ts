import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";
import { type Codec, defaultCodec } from "./codec.js";
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
const LINK_MODE = 0o120777;

/** Links followed before a path counts as unresolvable (POSIX ELOOP territory). */
const MAX_SYMLINK_HOPS = 8;

export interface SqlarFilesApiOptions {
  /** Defaults to {@link defaultCodec}. */
  codec?: Codec;
}

/**
 * A FilesApi whose whole state is one SQLite Archive table.
 *
 * SQLAR can also hold symlinks, which `FileKind` cannot express. The FilesApi
 * view follows them the way POSIX `stat()` does — an unresolvable link is a
 * missing path — and {@link symlink} / {@link readlink} expose the link itself.
 */
export class SqlarFilesApi implements FilesApi {
  readonly #sql: SqlDriver;
  readonly #codec: Codec;

  constructor(sql: SqlDriver, opts: SqlarFilesApiOptions = {}) {
    this.#sql = sql;
    this.#codec = opts.codec ?? defaultCodec();
  }

  /** Creates the table if it is missing. Await it before any other call. */
  async init(): Promise<void> {
    await this.#sql.run(SCHEMA);
  }

  /** A missing path or a directory yields nothing; a file yields one chunk. */
  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    options.signal?.throwIfAborted();
    const resolved = await this.#resolve(toName(path));
    if (resolved?.stats.kind !== "file") return;

    const rows = await this.#sql.all<{ data: unknown }>(
      "SELECT data FROM sqlar WHERE name = ?",
      resolved.name,
    );
    const content = await this.#content(resolved.name, resolved.stats.size, toBytes(rows[0]?.data));
    options.signal?.throwIfAborted();
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

    let data: Uint8Array = bytes;
    if (bytes.byteLength >= this.#codec.minSize) {
      const deflated = await this.#codec.deflate(bytes);
      // Strictly shorter only: equal length is the plaintext marker.
      if (deflated.byteLength < bytes.byteLength) data = deflated;
    }
    await this.#put(name, FILE_MODE, bytes.byteLength, data);
  }

  /** `sz = 0` with `data IS NULL` is the format's only marker for a directory. */
  async mkdir(path: string): Promise<void> {
    const name = toName(path);
    for (const dir of ancestorsAndSelf(name)) {
      if (!(await this.#row(dir))) await this.#put(dir, DIR_MODE, 0, null);
    }
  }

  /** Writes a symlink row: `sz = -1`, the target verbatim as TEXT. */
  async symlink(path: string, target: string): Promise<void> {
    const name = toName(path);
    await this.mkdir(parentName(name));
    await this.#put(name, LINK_MODE, -1, target);
  }

  /** The stored target of a symlink, or `undefined` for anything else. */
  async readlink(path: string): Promise<string | undefined> {
    const row = await this.#row(toName(path));
    return row && isSymlink(row) ? linkTarget(row) : undefined;
  }

  async stats(path: string): Promise<FileStats | undefined> {
    return (await this.#resolve(toName(path)))?.stats;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#resolve(toName(path))) !== undefined;
  }

  /**
   * SQLAR is a flat keyspace, so the tree is derived from names: a path that
   * only exists as a prefix of other names is yielded as a directory, once,
   * before anything under it. Link entries report their target's stats; a
   * recursive listing never descends through one, which rules out cycles.
   */
  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    const requested = toName(path);
    const resolved = await this.#resolve(requested);
    if (resolved?.stats.kind !== "directory") return;

    // Paths are reported under the requested name even when it is a link.
    const base = resolved.name;
    const range = descendants(base);
    const rows = await this.#sql.all<StoredRow>(
      `SELECT ${ROW_COLUMNS} FROM sqlar WHERE ${range.where} ORDER BY name`,
      ...range.params,
    );
    const prefixLength = base === "" ? 0 : base.length + 1;
    const seen = new Set<string>();

    for (const row of rows) {
      const relative = row.name.slice(prefixLength);
      const segments = relative.split("/");
      const depth = options.recursive ? segments.length : 1;
      // Implicit directories on the way down to this row.
      for (let i = 1; i < Math.min(depth + 1, segments.length); i++) {
        const dir = segments.slice(0, i).join("/");
        if (seen.has(dir)) continue;
        seen.add(dir);
        yield { kind: "directory", name: segments[i - 1], path: `/${joinName(requested, dir)}` };
      }
      if (segments.length > depth || seen.has(relative)) continue;
      seen.add(relative);
      const stats = isSymlink(row) ? (await this.#resolve(row.name))?.stats : toStats(row);
      if (!stats) continue;
      yield {
        ...stats,
        name: segments[segments.length - 1],
        path: `/${joinName(requested, relative)}`,
      };
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
    const rows = await this.#sql.all<{
      name: string;
      mode: number;
      sz: number;
      dtype: string;
      data: unknown;
    }>(
      `SELECT name, mode, sz, typeof(data) AS dtype, data FROM sqlar WHERE ${range.where}`,
      ...range.params,
    );
    if (rows.length === 0) return false;

    await this.mkdir(parentName(to));
    for (const row of rows) {
      const name = joinName(to, row.name.slice(from.length).replace(/^\//, ""));
      await this.#put(name, row.mode, row.sz, storedData(row.dtype, row.data));
    }
    return true;
  }

  async move(source: string, target: string): Promise<boolean> {
    if (!(await this.copy(source, target))) return false;
    await this.remove(source);
    return true;
  }

  /** `length(data) = sz` is plaintext, `< sz` is compressed, `> sz` is corrupt. */
  async #content(name: string, sz: number, data: Uint8Array): Promise<Uint8Array> {
    if (data.byteLength === sz) return data;
    if (data.byteLength > sz) {
      throw new Error(`sqlar: ${name} has length(data)=${data.byteLength} > sz=${sz}`);
    }
    let inflated: Uint8Array;
    try {
      inflated = await this.#codec.inflate(data);
    } catch (cause) {
      // Codec errors name neither the file nor, for DecompressionStream, anything at all.
      const reason = cause instanceof Error && cause.message ? cause.message : String(cause);
      throw new Error(`sqlar: ${name} cannot be inflated: ${reason}`, { cause });
    }
    if (inflated.byteLength !== sz) {
      throw new Error(`sqlar: ${name} inflated ${inflated.byteLength} bytes, sz ${sz}`);
    }
    return inflated;
  }

  /**
   * The entry a stored name leads to, following symlinks in the final
   * component. `undefined` for a missing path, a dangling link or a chain
   * longer than {@link MAX_SYMLINK_HOPS}.
   */
  async #resolve(start: string): Promise<Resolved | undefined> {
    let name = start;
    for (let hops = 0; ; hops++) {
      if (name === "") return { name, stats: { kind: "directory" } };
      const row = await this.#row(name);
      if (!row) {
        return (await this.#hasDescendants(name))
          ? { name, stats: { kind: "directory" } }
          : undefined;
      }
      if (!isSymlink(row)) return { name, stats: toStats(row) };
      if (hops === MAX_SYMLINK_HOPS) return undefined;
      name = resolveTarget(row.name, linkTarget(row));
    }
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

/** Row metadata without file content, so listings never load blobs. */
interface StoredRow {
  name: string;
  mode: number;
  mtime: number;
  sz: number;
  /** `typeof(data)`: "null" for directories, "blob" for files, "text" for link targets. */
  dtype: string;
  /** The link target for a symlink row, NULL otherwise. */
  target: unknown;
}

const ROW_COLUMNS =
  "name, mode, mtime, sz, typeof(data) AS dtype, CASE WHEN sz = -1 THEN data END AS target";

interface Resolved {
  /** The stored name the path resolved to. */
  name: string;
  stats: FileStats;
}

/** Classification follows sz and data only: other writers may not set mode's type bits. */
function isSymlink(row: StoredRow): boolean {
  return row.sz === -1;
}

function toStats(row: StoredRow): FileStats {
  if (row.sz === 0 && row.dtype === "null") return { kind: "directory" };
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

function linkTarget(row: StoredRow): string {
  return typeof row.target === "string"
    ? row.target
    : new TextDecoder().decode(toBytes(row.target));
}

/**
 * A link target as a stored name: absolute from the root, relative from the
 * link's parent, with "." and ".." collapsed.
 */
function resolveTarget(linkName: string, target: string): string {
  const out = target.startsWith("/") ? [] : parentName(linkName).split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/** A selected `data` value, ready to bind again: NULL, TEXT or a byte blob. */
function storedData(dtype: string, data: unknown): Uint8Array | string | null {
  if (dtype === "null") return null;
  if (dtype === "text") {
    return typeof data === "string" ? data : new TextDecoder().decode(toBytes(data));
  }
  return toBytes(data);
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
