import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";
import type { FileGuard, FileOperation } from "./types.js";

interface MountEntry {
  prefix: string;
  api: FilesApi;
}

export class CompositeFilesApi implements FilesApi {
  private mounts: MountEntry[];
  private guards: FileGuard[] = [];

  constructor(root: FilesApi) {
    this.mounts = [{ prefix: "/", api: root }];
  }

  mount(path: string, api: FilesApi): this {
    const prefix = normalizePath(path);
    if (prefix === "/") {
      throw new Error("Cannot mount at root — root is set via constructor");
    }
    this.mounts.push({ prefix, api });
    // Sort by prefix length descending so longest match comes first
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    return this;
  }

  guard(operations: FileOperation[], check: (path: string) => boolean, message?: string): this {
    this.guards.push({ operations, check, message });
    return this;
  }

  // --- Mount resolution ---

  private resolve(path: string): { api: FilesApi; resolvedPath: string } {
    const normalized = normalizePath(path);
    for (const mount of this.mounts) {
      if (mount.prefix === "/") {
        return { api: mount.api, resolvedPath: normalized };
      }
      if (normalized === mount.prefix || normalized.startsWith(`${mount.prefix}/`)) {
        const resolvedPath = normalized.slice(mount.prefix.length) || "/";
        return { api: mount.api, resolvedPath };
      }
    }
    // Fallback to root (always last after sort)
    return { api: this.mounts[this.mounts.length - 1].api, resolvedPath: normalizePath(path) };
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

  // --- Guard checking ---

  private checkGuard(operation: FileOperation, path: string): void {
    const normalized = normalizePath(path);
    for (const guard of this.guards) {
      if (!guard.operations.includes(operation)) continue;
      if (!guard.check(normalized)) {
        const msg = guard.message ?? "Access denied";
        throw new Error(`${msg}: ${normalized}`);
      }
    }
  }

  // --- FilesApi implementation ---

  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    this.checkGuard("read", path);
    const { api, resolvedPath } = this.resolve(path);
    return api.read(resolvedPath, options);
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    this.checkGuard("write", path);
    const { api, resolvedPath } = this.resolve(path);
    return api.write(resolvedPath, content);
  }

  async mkdir(path: string): Promise<void> {
    this.checkGuard("mkdir", path);
    const { api, resolvedPath } = this.resolve(path);
    return api.mkdir(resolvedPath);
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    this.checkGuard("list", path);
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
        for await (const entry of mount.api.list("/", { recursive: true })) {
          yield { ...entry, path: `${mountPrefix}${entry.path === "/" ? "" : entry.path}` };
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
    this.checkGuard("remove", path);
    const { api, resolvedPath } = this.resolve(path);
    return api.remove(resolvedPath);
  }

  async move(source: string, target: string): Promise<boolean> {
    this.checkGuard("move", source);
    this.checkGuard("move", target);
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
    this.checkGuard("copy", source);
    this.checkGuard("copy", target);
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
