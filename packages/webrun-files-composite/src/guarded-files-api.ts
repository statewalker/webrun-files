import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";
import type { FileGuard, FileOperation } from "./types.js";

/**
 * `FilesApi` decorator that runs every call through an ordered list of
 * {@link FileGuard}s. A guard fires when its `operations` set intersects the
 * effective operation(s) for the current call. The first guard whose
 * `check` returns `false` aborts the call by throwing an `Error` with that
 * guard's `message` (defaulting to `"Access denied"`) followed by the
 * normalized path.
 *
 * Effective operations per call:
 *
 * | Method        | Operations checked                                  |
 * | ------------- | --------------------------------------------------- |
 * | `read`        | `read`                                              |
 * | `write`       | `write`                                             |
 * | `mkdir`       | `mkdir`                                             |
 * | `remove`      | `remove`                                            |
 * | `list`        | `list` on the path AND on each directory entry      |
 * | `stats`       | `list` (a stat reveals existence like a tiny list)  |
 * | `exists`      | `read` (existence is a read of metadata)            |
 * | `move(s, t)`  | `move`+`read` on source; `move`+`write` on target   |
 * | `copy(s, t)`  | `copy`+`read` on source; `copy`+`write` on target   |
 *
 * The expanded checks for `move`/`copy` mean a guard that blocks `read` on
 * a path also prevents move/copy *from* that path, and a `write`-blocking
 * guard prevents move/copy *to* it. Likewise, an `exists` call respects any
 * read guard, and `stats` respects any list guard.
 *
 * @example
 * ```ts
 * const api = new GuardedFilesApi(source, [
 *   {
 *     operations: ["write", "remove", "move", "mkdir"],
 *     check: (p) => !p.startsWith("/.system/"),
 *     message: "system folder is read-only",
 *   },
 * ]);
 * await api.write("/.system/cfg", data); // throws "system folder is read-only: /.system/cfg"
 * ```
 */
export class GuardedFilesApi implements FilesApi {
  private readonly source: FilesApi;
  private readonly guards: FileGuard[];

  /**
   * @param source The underlying `FilesApi` whose calls will be policed.
   *   Allowed operations delegate straight through.
   * @param guards Ordered list of access policies. The wrapper takes a
   *   defensive copy, so mutating the array afterwards has no effect.
   *   An empty list disables every check (the wrapper becomes a passthrough).
   */
  constructor(source: FilesApi, guards: FileGuard[]) {
    this.source = source;
    this.guards = [...guards];
  }

  private checkGuard(path: string, ...operations: FileOperation[]): void {
    const normalized = normalizePath(path);
    for (const guard of this.guards) {
      if (!operations.some((op) => guard.operations.includes(op))) continue;
      if (!guard.check(normalized)) {
        const msg = guard.message ?? "Access denied";
        throw new Error(`${msg}: ${normalized}`);
      }
    }
  }

  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    this.checkGuard(path, "read");
    return this.source.read(path, options);
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    this.checkGuard(path, "write");
    return this.source.write(path, content);
  }

  async mkdir(path: string): Promise<void> {
    this.checkGuard(path, "mkdir");
    return this.source.mkdir(path);
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    this.checkGuard(path, "list");
    for await (const info of this.source.list(path, options)) {
      if (info.kind === "directory") {
        this.checkGuard(info.path, "list");
      }
      yield info;
    }
  }

  stats(path: string): Promise<FileStats | undefined> {
    this.checkGuard(path, "list");
    return this.source.stats(path);
  }

  exists(path: string): Promise<boolean> {
    this.checkGuard(path, "read");
    return this.source.exists(path);
  }

  async remove(path: string): Promise<boolean> {
    this.checkGuard(path, "remove");
    return this.source.remove(path);
  }

  async move(source: string, target: string): Promise<boolean> {
    this.checkGuard(source, "move", "read");
    this.checkGuard(target, "move", "write");
    return this.source.move(source, target);
  }

  async copy(source: string, target: string): Promise<boolean> {
    this.checkGuard(source, "copy", "read");
    this.checkGuard(target, "copy", "write");
    return this.source.copy(source, target);
  }
}
