import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { comparePaths, joinPath, mergeInPathOrder, normalizePath } from "@statewalker/webrun-files";

interface MountEntry {
  prefix: string;
  api: FilesApi;
  basePath: string;
}

/**
 * Composite `FilesApi` that routes calls to one of several backends based
 * on a path prefix. Mounts are matched by **longest prefix wins**, so a
 * mount at `/a/b` takes precedence over a mount at `/a` for paths under
 * `/a/b/...`. The mount point itself appears in listings as a synthetic
 * directory and cannot be removed.
 *
 * Each backend can use a sub-directory of its own filesystem as the mount
 * root via `fsPath` (constructor `rootPath` for the implicit root mount,
 * `fsPath` argument for additional mounts). Cross-mount `move` is
 * implemented as copy-then-delete; there is no atomicity guarantee.
 *
 * Access control and visibility filtering are intentionally **not** part of
 * this class — wrap with {@link GuardedFilesApi} or {@link FilteredFilesApi}
 * (or both) instead.
 *
 * @example
 * ```ts
 * const fs = new CompositeFilesApi(localFs, "/projects")
 *   .mount("/docs", s3Fs, "/documentation")
 *   .mount("/cache", memFs);
 * await fs.write("/readme.md", data); // → localFs:/projects/readme.md
 * await fs.write("/docs/api.md", data); // → s3Fs:/documentation/api.md
 * ```
 */
export class CompositeFilesApi implements FilesApi {
  private mounts: MountEntry[];

  /**
   * @param root Default backend used for any path that does not match a
   *   more specific mount. All paths are routed here unless `mount()`
   *   intercepts them.
   * @param rootPath Optional sub-directory of the root backend to use as
   *   the composite filesystem's `/`. For example, `rootPath = "/projects"`
   *   makes the composite path `/readme.md` resolve to `/projects/readme.md`
   *   in the root backend. Defaults to `"/"` (no remapping).
   */
  constructor(root: FilesApi, rootPath?: string) {
    this.mounts = [{ prefix: "/", api: root, basePath: normalizePath(rootPath ?? "/") }];
  }

  /**
   * Attaches a backend to handle every composite path under `path`. The
   * mount prefix is normalized; paths under it are resolved against the
   * mount's `fsPath` sub-directory (defaulting to `"/"`).
   *
   * @param path Composite-namespace prefix (e.g. `"/docs"`). Mounting at
   *   `"/"` is forbidden — use the constructor `root` argument instead.
   * @param api The backend `FilesApi` to delegate to for paths under
   *   `path`. Wrap it in {@link FilteredFilesApi} / {@link GuardedFilesApi}
   *   first if you want mount-local filtering or guards.
   * @param fsPath Sub-directory of the mounted backend used as its mount
   *   root, e.g. `mount("/docs", s3, "/documentation")` makes
   *   `/docs/api.md` resolve to `/documentation/api.md` on `s3`.
   * @returns `this`, for chaining.
   * @throws If `path` normalizes to `"/"`.
   */
  mount(path: string, api: FilesApi, fsPath?: string): this {
    const prefix = normalizePath(path);
    if (prefix === "/") {
      throw new Error("Cannot mount at root — root is set via constructor");
    }
    this.mounts.push({ prefix, api, basePath: normalizePath(fsPath ?? "/") });
    // Sort by prefix length descending so longest match comes first
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    return this;
  }

  // --- Mount resolution ---

  private resolve(path: string): { api: FilesApi; resolvedPath: string } {
    const normalized = normalizePath(path);
    for (const mount of this.mounts) {
      if (mount.prefix === "/") {
        return { api: mount.api, resolvedPath: joinPath(mount.basePath, normalized) };
      }
      if (normalized === mount.prefix || normalized.startsWith(`${mount.prefix}/`)) {
        const localPath = normalized.slice(mount.prefix.length) || "/";
        return { api: mount.api, resolvedPath: joinPath(mount.basePath, localPath) };
      }
    }
    // Fallback to root (always last after sort)
    const rootMount = this.mounts[this.mounts.length - 1];
    return { api: rootMount.api, resolvedPath: joinPath(rootMount.basePath, normalizePath(path)) };
  }

  private isMountPoint(path: string): boolean {
    const normalized = normalizePath(path);
    return this.mounts.some((m) => m.prefix === normalized && m.prefix !== "/");
  }

  /** Returns mount prefixes that are direct children of the given path. */
  private childMountPrefixes(parentPath: string): string[] {
    const normalized = normalizePath(parentPath);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const result: string[] = [];
    for (const mount of this.mounts) {
      if (mount.prefix === "/") continue;
      if (!mount.prefix.startsWith(prefix)) continue;
      // Check if this mount is a direct child (no further slashes after the prefix)
      const relative = mount.prefix.slice(prefix.length);
      if (!relative.includes("/")) {
        result.push(mount.prefix);
      }
    }
    return result;
  }

  // --- FilesApi implementation ---

  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const { api, resolvedPath } = this.resolve(path);
    return api.read(resolvedPath, options);
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const { api, resolvedPath } = this.resolve(path);
    return api.write(resolvedPath, content);
  }

  async mkdir(path: string): Promise<void> {
    const { api, resolvedPath } = this.resolve(path);
    return api.mkdir(resolvedPath);
  }

  /**
   * Merges, in `comparePaths` order: a synthetic directory entry for each
   * mount inside `path`; the owning backend's listing with those mounts'
   * subtrees removed; and, when recursive, each inner mount's own listing
   * with its nested mounts removed. Each backend's listing is already ordered
   * and remapping a subtree's prefix keeps that order, so a k-way merge is
   * enough. `after` is translated into each backend's namespace, and a mount
   * whose whole subtree lies at or before it is not listed.
   */
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const normalized = normalizePath(path);
    const recursive = options?.recursive ?? false;
    const after = options?.after;
    const owner = this.ownerOf(normalized);
    const { resolvedPath } = this.resolve(normalized);

    const inner = this.mounts.filter(
      (m) => m.prefix !== "/" && isStrictlyInside(m.prefix, normalized),
    );
    const listed = recursive
      ? inner
      : this.childMountPrefixes(normalized).map(
          (prefix) => inner.find((m) => m.prefix === prefix) as MountEntry,
        );

    const streams: AsyncIterable<FileInfo>[] = [];
    // Synthetic mount points come first, so they win over a same-named backend
    // entry. Mounts are kept longest-prefix first, so this stream is sorted.
    streams.push(
      fromArray(
        listed
          .map((m) => ({
            kind: "directory" as const,
            name: m.prefix.slice(m.prefix.lastIndexOf("/") + 1),
            path: m.prefix,
          }))
          .sort((x, y) => comparePaths(x.path, y.path)),
      ),
    );
    streams.push(
      this.remappedList(
        owner.api,
        resolvedPath,
        normalized,
        recursive,
        after,
        inner.map((m) => m.prefix),
      ),
    );
    if (recursive) {
      for (const m of inner) {
        const nested = inner
          .filter((n) => isStrictlyInside(n.prefix, m.prefix))
          .map((n) => n.prefix);
        streams.push(this.remappedList(m.api, m.basePath, m.prefix, true, after, nested));
      }
    }

    for await (const entry of mergeInPathOrder(streams)) {
      if (after === undefined || comparePaths(entry.path, after) > 0) yield entry;
    }
  }

  /**
   * One backend's listing of `backendDir`, with paths moved to `compositeDir`
   * and entries at or under any of `excluded` dropped.
   */
  private async *remappedList(
    api: FilesApi,
    backendDir: string,
    compositeDir: string,
    recursive: boolean,
    after: string | undefined,
    excluded: string[],
  ): AsyncIterable<FileInfo> {
    const translated = translateAfter(after, compositeDir, backendDir);
    if (translated === SKIP) return;
    for await (const entry of api.list(backendDir, { recursive, after: translated })) {
      const compositePath = this.remapPath(compositeDir, backendDir, entry.path);
      if (this.isUnderChildMount(compositePath, excluded)) continue;
      yield { ...entry, path: compositePath };
    }
  }

  /** The mount that owns `normalized` — the longest matching prefix, else the root. */
  private ownerOf(normalized: string): MountEntry {
    for (const mount of this.mounts) {
      if (
        mount.prefix === "/" ||
        normalized === mount.prefix ||
        normalized.startsWith(`${mount.prefix}/`)
      ) {
        return mount;
      }
    }
    return this.mounts[this.mounts.length - 1];
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const normalized = normalizePath(path);
    if (this.isMountPoint(normalized)) {
      return { kind: "directory" };
    }
    const { api, resolvedPath } = this.resolve(path);
    return api.stats(resolvedPath);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (this.isMountPoint(normalized)) {
      return true;
    }
    const { api, resolvedPath } = this.resolve(path);
    return api.exists(resolvedPath);
  }

  async remove(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (this.isMountPoint(normalized)) {
      throw new Error(`Cannot remove mount point: ${normalized}`);
    }
    const { api, resolvedPath } = this.resolve(path);
    return api.remove(resolvedPath);
  }

  async move(source: string, target: string): Promise<boolean> {
    const src = this.resolve(source);
    const tgt = this.resolve(target);

    // Same mount: delegate directly
    if (src.api === tgt.api) {
      return src.api.move(src.resolvedPath, tgt.resolvedPath);
    }

    // Cross-mount: copy then remove
    const copied = await this.crossCopy(src.api, src.resolvedPath, tgt.api, tgt.resolvedPath);
    if (copied) {
      await src.api.remove(src.resolvedPath);
    }
    return copied;
  }

  async copy(source: string, target: string): Promise<boolean> {
    const src = this.resolve(source);
    const tgt = this.resolve(target);

    // Same mount: delegate directly
    if (src.api === tgt.api) {
      return src.api.copy(src.resolvedPath, tgt.resolvedPath);
    }

    // Cross-mount copy
    return this.crossCopy(src.api, src.resolvedPath, tgt.api, tgt.resolvedPath);
  }

  // --- Helpers ---

  private async crossCopy(
    srcApi: FilesApi,
    srcPath: string,
    tgtApi: FilesApi,
    tgtPath: string,
  ): Promise<boolean> {
    const srcStats = await srcApi.stats(srcPath);
    if (!srcStats) return false;

    if (srcStats.kind === "file") {
      await tgtApi.write(tgtPath, srcApi.read(srcPath));
      return true;
    }

    // Directory: recursive copy
    await tgtApi.mkdir(tgtPath);
    for await (const entry of srcApi.list(srcPath)) {
      const childSrc = srcPath === "/" ? `/${entry.name}` : `${srcPath}/${entry.name}`;
      const childTgt = tgtPath === "/" ? `/${entry.name}` : `${tgtPath}/${entry.name}`;
      if (entry.kind === "file") {
        await tgtApi.write(childTgt, srcApi.read(childSrc));
      } else {
        await this.crossCopy(srcApi, childSrc, tgtApi, childTgt);
      }
    }
    return true;
  }

  private remapPath(
    compositeParent: string,
    resolvedParent: string,
    resolvedChild: string,
  ): string {
    // Convert a resolved path back into composite namespace
    const relative = resolvedChild.startsWith(resolvedParent)
      ? resolvedChild.slice(resolvedParent.length)
      : resolvedChild;
    if (compositeParent === "/") {
      return relative.startsWith("/") ? relative : `/${relative}`;
    }
    return `${compositeParent}${relative.startsWith("/") ? relative : `/${relative}`}`;
  }

  private isUnderChildMount(compositePath: string, childMounts: string[]): boolean {
    for (const mount of childMounts) {
      if (compositePath === mount || compositePath.startsWith(`${mount}/`)) {
        return true;
      }
    }
    return false;
  }
}

const SKIP = Symbol("skip");

/**
 * `after`, given in the `from` subtree's namespace, in the `to` subtree's
 * namespace — or {@link SKIP} when the whole `from` subtree lies at or before
 * it. Raw prefix replacement, never normalisation: normalising `"/a/"` to
 * `"/a"` would change which entries sort after it. Under-pruning is harmless
 * (the caller filters again); over-pruning is what this must never do.
 */
function translateAfter(
  after: string | undefined,
  from: string,
  to: string,
): string | undefined | typeof SKIP {
  if (after === undefined) return undefined;
  const fromPrefix = from === "/" ? "" : from;
  const toPrefix = to === "/" ? "" : to;
  if (after.startsWith(`${fromPrefix}/`)) return `${toPrefix}${after.slice(fromPrefix.length)}`;
  // Every descendant of `from` lies between `from + "/"` and `from + "0"`.
  if (comparePaths(after, `${fromPrefix}/`) < 0) return undefined;
  return SKIP;
}

function isStrictlyInside(path: string, ancestor: string): boolean {
  return ancestor === "/" ? path !== "/" : path.startsWith(`${ancestor}/`);
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  yield* items;
}
