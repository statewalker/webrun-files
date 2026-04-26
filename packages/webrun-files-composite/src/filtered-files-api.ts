import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalizePath } from "@statewalker/webrun-files";

/**
 * Predicate evaluated against a **normalized** path (single leading slash,
 * no trailing slash) by `FilteredFilesApi` to decide visibility.
 *
 * - `true` → the path is visible (the wrapped operation runs).
 * - `false` → the path is hidden (the wrapper short-circuits as if the path
 *   did not exist).
 *
 * The predicate may be synchronous or return a `Promise<boolean>`. When
 * async, it is awaited on each call — so prefer pure / cheap checks.
 */
export type PathFilter = (path: string) => boolean | Promise<boolean>;

/**
 * Builds a {@link PathFilter} that hides any path whose normalized form
 * equals one of the provided prefixes or lives under `${prefix}/`.
 *
 * Prefixes are normalized through `normalizePath` (so `"foo"`, `"/foo"`, and
 * `"/foo/"` are equivalent). Empty / root entries are dropped — they would
 * otherwise hide every path.
 *
 * Matching is **boundary-aware**: the prefix `"/priv"` does not match the
 * path `"/private"` because there is no `/` boundary between them.
 *
 * @param pathPrefixes Path prefixes whose contents (and the prefix itself)
 *   should be hidden. Pass none to hide nothing.
 *
 * @example
 * ```ts
 * const filter = newPathFilter("/.git", "/node_modules");
 * filter("/src/index.ts"); // true
 * filter("/.git");         // false
 * filter("/.git/HEAD");    // false
 * filter("/notgit");       // true (boundary-aware, no false match)
 * ```
 */
export function newPathFilter(...pathPrefixes: string[]): PathFilter {
  const normalized = pathPrefixes.map((p) => normalizePath(p)).filter((p) => p !== "/");
  return (path: string) => {
    const target = normalizePath(path);
    for (const prefix of normalized) {
      if (target === prefix) return false;
      if (target.startsWith(`${prefix}/`)) return false;
    }
    return true;
  };
}

/**
 * Builds a {@link PathFilter} that hides any path whose normalized form
 * matches at least one of the provided regular expressions.
 *
 * The path is normalized through `normalizePath` before matching, so a
 * regexp anchored on `^/` always sees a leading slash and never a trailing
 * one. The regexp's `lastIndex` is irrelevant — the filter calls `test`
 * via a fresh evaluation each time, but stateful (`/g`, `/y`) regexps
 * still mutate `lastIndex` across calls; pass non-stateful regexps unless
 * you know what you are doing.
 *
 * @param pathRegexps Regular expressions whose match means "hide this
 *   path". Pass none to hide nothing.
 *
 * @example
 * ```ts
 * // Hide every dotfile and every *.log file
 * const filter = newRegexpPathFilter(/\/\.[^/]+$/, /\.log$/);
 * filter("/src/index.ts"); // true
 * filter("/.env");         // false (matches /\/\.[^/]+$/)
 * filter("/build.log");    // false (matches /\.log$/)
 * ```
 */
export function newRegexpPathFilter(...pathRegexps: RegExp[]): PathFilter {
  return (path: string) => {
    const target = normalizePath(path);
    for (const regexp of pathRegexps) {
      if (regexp.test(target)) return false;
    }
    return true;
  };
}

/**
 * `FilesApi` decorator that hides every path the supplied {@link PathFilter}
 * rejects. Hidden paths are treated as if they do not exist:
 *
 * - `read` / `list` yield empty iterables.
 * - `stats` returns `undefined`; `exists` returns `false`.
 * - `remove` returns `false` (no error, nothing changed).
 * - `move` / `copy` return `false` if either endpoint is hidden.
 * - `write` / `mkdir` reject with an `Error` (since silently dropping a
 *   write would lose data).
 * - `list` recursively skips entries whose paths are hidden, so iterating a
 *   visible parent never reveals a hidden child.
 *
 * Wrap any `FilesApi` to scope its visibility without changing the
 * underlying storage; the wrapped instance still holds the data, it is just
 * not reachable through this decorator.
 *
 * @example
 * ```ts
 * import {
 *   FilteredFilesApi,
 *   newPathFilter,
 *   newRegexpPathFilter,
 * } from "@statewalker/webrun-files-composite";
 *
 * // Hide by path prefix
 * const noVcs = new FilteredFilesApi(sourceFiles, newPathFilter("/.git", "/.cache"));
 * await noVcs.exists("/.git");        // false
 * await noVcs.write("/.git/x", data); // throws "Path is hidden"
 *
 * // Hide by regexp
 * const noLogs = new FilteredFilesApi(sourceFiles, newRegexpPathFilter(/\.log$/));
 * ```
 */
export class FilteredFilesApi implements FilesApi {
  private readonly source: FilesApi;
  private readonly pathFilter: PathFilter;

  /**
   * @param source The underlying `FilesApi` whose paths will be selectively
   *   hidden. Operations always delegate to this instance; the decorator
   *   only adds the visibility check.
   * @param pathFilter Predicate that decides per-call whether a normalized
   *   path is visible. See {@link PathFilter}.
   */
  constructor(source: FilesApi, pathFilter: PathFilter) {
    this.source = source;
    this.pathFilter = pathFilter;
  }

  protected async isHidden(path: string): Promise<boolean> {
    return (await this.pathFilter(normalizePath(path))) === false;
  }

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    if (await this.isHidden(path)) return;
    yield* this.source.read(path, options);
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    if (await this.isHidden(path)) {
      throw new Error(`Path is hidden: ${path}`);
    }
    await this.source.write(path, content);
  }

  async mkdir(path: string): Promise<void> {
    if (await this.isHidden(path)) {
      throw new Error(`Path is hidden: ${path}`);
    }
    await this.source.mkdir(path);
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    if (await this.isHidden(path)) return;
    for await (const entry of this.source.list(path, options)) {
      if (await this.isHidden(entry.path)) continue;
      yield entry;
    }
  }

  async stats(path: string): Promise<FileStats | undefined> {
    if (await this.isHidden(path)) return undefined;
    return this.source.stats(path);
  }

  async exists(path: string): Promise<boolean> {
    if (await this.isHidden(path)) return false;
    return this.source.exists(path);
  }

  async remove(path: string): Promise<boolean> {
    if (await this.isHidden(path)) return false;
    return this.source.remove(path);
  }

  async move(source: string, target: string): Promise<boolean> {
    if ((await this.isHidden(source)) || (await this.isHidden(target))) {
      return false;
    }
    return this.source.move(source, target);
  }

  async copy(source: string, target: string): Promise<boolean> {
    if ((await this.isHidden(source)) || (await this.isHidden(target))) {
      return false;
    }
    return this.source.copy(source, target);
  }
}
