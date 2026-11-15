import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import {
  basename,
  dirname,
  joinPath,
  listInPathOrder,
  normalizePath,
  removeMovedSource,
} from "@statewalker/webrun-files";

/** Options for {@link cow}. */
export interface CowOptions {
  /**
   * Filename prefix for per-path whiteout markers, stored in the writable
   * layer. A whiteout for `/dir/name` lives at `/dir/<prefix>name`.
   * Defaults to `".wh."`.
   */
  whiteoutPrefix?: string;
  /**
   * Filename for the opaque-directory marker, stored as a child of a
   * directory whose base subtree has been deleted. Defaults to `".wh..opq"`.
   */
  opaqueName?: string;
}

type Layer = "writable" | "base" | "absent";

/**
 * Copy-on-write view: a writable layer over a read-only `base`. The `base`
 * is **never** mutated — every change (write, delete, move) is recorded in
 * the `writable` layer, using marker files to record deletions.
 *
 * Resolution precedence for any path:
 * 1. a covering whiteout / opaque marker ⇒ the path is absent;
 * 2. otherwise the `writable` layer, if it has the path;
 * 3. otherwise fall through to `base`.
 *
 * Deletions are persisted as marker files inside the writable layer, so they
 * survive across process restarts and work over any `FilesApi` backend.
 * Markers are hidden from `read` / `list` / `stats` / `exists`.
 *
 * Use {@link cow} to construct one.
 */
class CowFilesApi implements FilesApi {
  private readonly base: FilesApi;
  private readonly writable: FilesApi;
  private readonly whiteoutPrefix: string;
  private readonly opaqueName: string;

  constructor(base: FilesApi, writable: FilesApi, opts?: CowOptions) {
    this.base = base;
    this.writable = writable;
    this.whiteoutPrefix = opts?.whiteoutPrefix ?? ".wh.";
    this.opaqueName = opts?.opaqueName ?? ".wh..opq";
  }

  // --- marker helpers ---

  private whiteoutPath(path: string): string {
    const p = normalizePath(path);
    return joinPath(dirname(p), `${this.whiteoutPrefix}${basename(p)}`);
  }

  private opaquePath(dir: string): string {
    return joinPath(normalizePath(dir), this.opaqueName);
  }

  private isMarker(name: string): boolean {
    return name.startsWith(this.whiteoutPrefix) || name === this.opaqueName;
  }

  private *ancestorsInclusive(dir: string): Iterable<string> {
    let cur = normalizePath(dir);
    yield cur;
    while (cur !== "/") {
      cur = dirname(cur);
      yield cur;
    }
  }

  private async hasDirectWhiteout(path: string): Promise<boolean> {
    return this.writable.exists(this.whiteoutPath(path));
  }

  /** True when an opaque marker on `dir` or any ancestor hides base content. */
  private async isBaseContentHidden(dir: string): Promise<boolean> {
    for (const ancestor of this.ancestorsInclusive(dir)) {
      if (await this.writable.exists(this.opaquePath(ancestor))) return true;
    }
    return false;
  }

  /** True when the base version of `path` is hidden by a marker. */
  private async isBaseHidden(path: string): Promise<boolean> {
    if (await this.hasDirectWhiteout(path)) return true;
    return this.isBaseContentHidden(dirname(normalizePath(path)));
  }

  private async resolveLayer(path: string): Promise<Layer> {
    if (await this.writable.exists(path)) return "writable";
    if (await this.isBaseHidden(path)) return "absent";
    if (await this.base.exists(path)) return "base";
    return "absent";
  }

  /** Removes a covering whiteout marker so a write/mkdir resurrects the path. */
  private async clearWhiteout(path: string): Promise<void> {
    const marker = this.whiteoutPath(path);
    if (await this.writable.exists(marker)) {
      await this.writable.remove(marker);
    }
  }

  // --- FilesApi ---

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const layer = await this.resolveLayer(path);
    if (layer === "writable") yield* this.writable.read(path, options);
    else if (layer === "base") yield* this.base.read(path, options);
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    await this.clearWhiteout(path);
    await this.writable.write(path, content);
  }

  async mkdir(path: string): Promise<void> {
    await this.clearWhiteout(path);
    await this.writable.mkdir(path);
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const layer = await this.resolveLayer(path);
    if (layer === "writable") return this.writable.stats(path);
    if (layer === "base") return this.base.stats(path);
    return undefined;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.resolveLayer(path)) !== "absent";
  }

  /** Merged children, walked in `comparePaths` order. */
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const dir = normalizePath(path);
    if ((await this.stats(dir))?.kind !== "directory") return;
    yield* listInPathOrder(dir, (d) => this.mergeChildren(d), options);
  }

  /** Direct children of `dir`: writable entries win, base entries fill in. */
  private async mergeChildren(dir: string): Promise<FileInfo[]> {
    const merged = new Map<string, FileInfo>();
    if ((await this.writable.stats(dir))?.kind === "directory") {
      for await (const entry of this.writable.list(dir)) {
        if (this.isMarker(entry.name)) continue;
        merged.set(entry.name, entry);
      }
    }
    const baseHidden = await this.isBaseContentHidden(dir);
    if (!baseHidden && (await this.base.stats(dir))?.kind === "directory") {
      for await (const entry of this.base.list(dir)) {
        if (merged.has(entry.name)) continue;
        if (await this.hasDirectWhiteout(entry.path)) continue;
        merged.set(entry.name, entry);
      }
    }
    return [...merged.values()];
  }

  async remove(path: string): Promise<boolean> {
    if ((await this.resolveLayer(path)) === "absent") return false;
    if (await this.writable.exists(path)) {
      await this.writable.remove(path);
    }
    // Record a whiteout only when the base still carries the path.
    const baseStats = await this.base.stats(path);
    if (baseStats) {
      const marker =
        baseStats.kind === "directory" ? this.opaquePath(path) : this.whiteoutPath(path);
      await this.writable.write(marker, []);
    }
    return true;
  }

  /**
   * NOT atomic: the composite view of the source is copied into the writable layer,
   * then the source is removed (deleted from the writable layer and/or hidden behind
   * a whiteout). While it runs the content exists in both places, and a directory
   * appears in the target file by file. A failed copy throws and keeps the source. If
   * the copy succeeds but the source cannot be removed, the removal is retried once,
   * then a `MoveIncompleteError` is thrown: the target holds the new content and the
   * source still exists. False is never returned for a half-done move.
   *
   * An existing target (as the composite view shows it) is treated as POSIX
   * `rename(2)` treats it, like `MemFilesApi` and `NodeFilesApi`: a file replaces a
   * file, and a directory replaces an empty directory. Everything else returns false
   * and changes nothing: a file onto a directory, a directory onto a file or onto a
   * non-empty directory, a directory into its own subtree, a target below a file, and
   * a missing source. A move onto itself is a successful no-op.
   */
  async move(source: string, target: string): Promise<boolean> {
    const from = normalizePath(source);
    const to = normalizePath(target);
    const stats = await this.stats(from);
    if (!stats) return false;
    if (from === to) return true;
    if (from === "/" || to.startsWith(`${from}/`)) return false;
    for (let dir = dirname(to); dir !== "/"; dir = dirname(dir)) {
      const kind = (await this.stats(dir))?.kind;
      if (kind === "file") return false;
      if (kind === "directory") break;
    }
    const targetStats = await this.stats(to);
    if (targetStats) {
      if (targetStats.kind !== stats.kind) return false;
      if (targetStats.kind === "directory") {
        for await (const _ of this.list(to)) return false;
      }
    }
    await this.copyInto(from, to, stats);
    await removeMovedSource(this, from, to);
    return true;
  }

  async copy(source: string, target: string): Promise<boolean> {
    const stats = await this.stats(source);
    if (!stats) return false;
    await this.copyInto(source, target, stats);
    return true;
  }

  /** Copies the composite view of `src` into the writable layer at `tgt`. */
  private async copyInto(src: string, tgt: string, stats: FileStats): Promise<void> {
    if (stats.kind === "file") {
      await this.write(tgt, this.read(src));
      return;
    }
    await this.mkdir(tgt);
    for await (const entry of this.list(src)) {
      await this.copyInto(entry.path, joinPath(tgt, entry.name), entry);
    }
  }
}

/**
 * Builds a copy-on-write `FilesApi`: a `writable` layer over a read-only
 * `base`. Reads fall through to `base`; every write goes to `writable`;
 * `base` is never mutated. Deletions are persisted as marker files in
 * `writable` (a per-path whiteout for files, one opaque marker for a deleted
 * base directory), so they survive over any backend and across restarts.
 *
 * @param base The read-only lower layer. Never mutated.
 * @param writable The upper layer that captures all changes and markers.
 * @param opts Marker naming overrides (see {@link CowOptions}).
 * @returns A read/write `FilesApi` composing the two layers.
 *
 * @example
 * ```ts
 * const fs = cow(releaseFiles, new MemFilesApi());
 * await fs.write("/a.txt", data); // captured in the writable layer
 * await fs.remove("/base-only");  // whiteout marker; base untouched
 * ```
 */
export function cow(base: FilesApi, writable: FilesApi, opts?: CowOptions): FilesApi {
  return new CowFilesApi(base, writable, opts);
}
