import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { joinPath, normalizePath } from "@statewalker/webrun-files";

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

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const normalized = normalizePath(path);
    const { api, resolvedPath } = this.resolve(path);

    const childMounts = this.childMountPrefixes(normalized);
    const yieldedNames = new Set<string>();

    if (options?.recursive) {
      // Yield entries from the primary mount
      for await (const entry of api.list(resolvedPath, options)) {
        // Remap path back to composite namespace
        const compositePath = this.remapPath(normalized, resolvedPath, entry.path);
        // Skip if this path falls under a child mount
        if (this.isUnderChildMount(compositePath, childMounts)) continue;
        yieldedNames.add(entry.name);
        yield { ...entry, path: compositePath };
      }
      // Recursively yield from child mounts
      for (const mountPrefix of childMounts) {
        const mount = this.mounts.find((m) => m.prefix === mountPrefix);
        if (!mount) continue;
        const mountName = mountPrefix.split("/").pop() ?? "";
        // Yield the mount directory entry itself
        yield { name: mountName, path: mountPrefix, kind: "directory" };
        for await (const entry of mount.api.list(mount.basePath, { recursive: true })) {
          const localPath = this.stripBasePath(entry.path, mount.basePath);
          yield { ...entry, path: `${mountPrefix}${localPath === "/" ? "" : localPath}` };
        }
      }
    } else {
      // Non-recursive: yield direct children from the primary mount
      for await (const entry of api.list(resolvedPath)) {
        const compositePath = this.remapPath(normalized, resolvedPath, entry.path);
        yieldedNames.add(entry.name);
        yield { ...entry, path: compositePath };
      }
      // Add synthetic directory entries for child mounts not already present
      for (const mountPrefix of childMounts) {
        const mountName = mountPrefix.split("/").pop() ?? "";
        if (!yieldedNames.has(mountName)) {
          yield { name: mountName, path: mountPrefix, kind: "directory" };
        }
      }
    }
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

  private stripBasePath(path: string, basePath: string): string {
    if (basePath === "/") return path;
    if (path === basePath) return "/";
    if (path.startsWith(`${basePath}/`)) return path.slice(basePath.length);
    return path;
  }

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
