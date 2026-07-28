import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";

/**
 * Read-only union of several `FilesApi` layers. A path is resolved
 * **top → bottom**: the first layer that has it wins for
 * `read` / `stats` / `exists`, and its entry (including `kind`) wins any
 * name clash in `list`. Listings merge and dedupe across every layer.
 *
 * The union never writes — every mutating call throws. Use
 * {@link overlay} to construct one.
 */
class OverlayFilesApi implements FilesApi {
  private readonly layers: FilesApi[];

  constructor(layers: FilesApi[]) {
    this.layers = layers;
  }

  private deny(op: string, path: string): never {
    throw new Error(`overlay is read-only (${op}): ${normalizePath(path)}`);
  }

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    for (const layer of this.layers) {
      if (await layer.exists(path)) {
        yield* layer.read(path, options);
        return;
      }
    }
  }

  async stats(path: string): Promise<FileStats | undefined> {
    for (const layer of this.layers) {
      const stats = await layer.stats(path);
      if (stats) return stats;
    }
    return undefined;
  }

  async exists(path: string): Promise<boolean> {
    for (const layer of this.layers) {
      if (await layer.exists(path)) return true;
    }
    return false;
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    yield* this.listDir(normalizePath(path), options?.recursive ?? false);
  }

  private async *listDir(dir: string, recursive: boolean): AsyncIterable<FileInfo> {
    const stats = await this.stats(dir);
    if (stats?.kind !== "directory") return;
    for (const entry of await this.mergeChildren(dir)) {
      yield entry;
      if (recursive && entry.kind === "directory") {
        yield* this.listDir(entry.path, true);
      }
    }
  }

  /** Direct children of `dir`, deduped by name with the topmost layer winning. */
  private async mergeChildren(dir: string): Promise<FileInfo[]> {
    const merged = new Map<string, FileInfo>();
    for (const layer of this.layers) {
      if ((await layer.stats(dir))?.kind !== "directory") continue;
      for await (const entry of layer.list(dir)) {
        if (!merged.has(entry.name)) merged.set(entry.name, entry);
      }
    }
    return [...merged.values()];
  }

  async write(path: string): Promise<void> {
    this.deny("write", path);
  }

  async mkdir(path: string): Promise<void> {
    this.deny("mkdir", path);
  }

  async remove(path: string): Promise<boolean> {
    return this.deny("remove", path);
  }

  async move(source: string): Promise<boolean> {
    return this.deny("move", source);
  }

  async copy(source: string): Promise<boolean> {
    return this.deny("copy", source);
  }
}

/**
 * Builds a **read-only** union view over `top` and any number of `lower`
 * layers. Reads resolve top → bottom (first layer that has the path wins);
 * `list` merges and dedupes across all layers with `top` winning a clash
 * (including a file-vs-directory `kind` clash). Every write is denied.
 *
 * @param top The highest-priority layer; its entries shadow the rest.
 * @param lower Additional layers, consulted in order after `top`.
 * @returns A read-only `FilesApi` union.
 *
 * @example
 * ```ts
 * const view = overlay(userFiles, defaultFiles);
 * await view.read("/config.json"); // userFiles if present, else defaultFiles
 * await view.write("/x", data);    // throws (read-only)
 * ```
 */
export function overlay(top: FilesApi, ...lower: FilesApi[]): FilesApi {
  return new OverlayFilesApi([top, ...lower]);
}
