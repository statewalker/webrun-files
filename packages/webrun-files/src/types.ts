/**
 * Core types for FilesApi abstraction
 */

export type FileKind = "file" | "directory";

/**
 * Options for reading file content with range support.
 *
 * @example
 * // Read 100 bytes starting at position 50
 * api.read("/file.bin", { start: 50, length: 100 })
 *
 * @example
 * // Read from position 1000 to end of file
 * api.read("/file.bin", { start: 1000 })
 */
export interface ReadOptions {
  /** Starting byte position (0-indexed). Defaults to 0. */
  start?: number;
  /** Number of bytes to read. If omitted, reads to end of file. */
  length?: number;
  /** AbortSignal for cancellation support. */
  signal?: AbortSignal;
}

/**
 * Options for listing directory contents.
 */
export interface ListOptions {
  /** If true, lists all descendants recursively. Defaults to false. */
  recursive?: boolean;
  /**
   * Yield only entries whose path sorts strictly after this one, in
   * `comparePaths` order. The path need not exist, and may lie outside
   * the listed directory: before it, everything is yielded; past it, nothing.
   *
   * Resuming with the last path yielded continues a listing exactly where it
   * stopped, without holding an iterator open between the calls.
   */
  after?: string;
}

/**
 * Metadata of a regular file.
 *
 * `size` and `lastModified` are REQUIRED. Every storage that can hold a file
 * can say how large it is and when it last changed; an implementation that
 * cannot is claiming less than it must, and the omission must surface as a
 * failure rather than as an `undefined` a consumer has to defend against.
 */
export interface FileEntryStats {
  kind: "file";
  /** Length in bytes. A zero-byte file is `0`, never `undefined`. */
  size: number;
  /** Modification time as milliseconds since the epoch. */
  lastModified: number;
}

/**
 * Metadata of a directory.
 *
 * Deliberately carries nothing else. A directory has no size, and a
 * modification time is available on some storages (memory, a local
 * filesystem) and unavailable on others (an object store, where a directory
 * is a common prefix that exists only as an artefact of key naming). Neither
 * value may be relied upon, so neither is part of the contract: an
 * implementation that happens to know one drops it here instead of leaking a
 * value consumers would have to treat as optional anyway.
 */
export interface DirectoryEntryStats {
  kind: "directory";
}

/**
 * File or directory metadata returned by `stats()`.
 *
 * A DISCRIMINATED UNION on `kind`, not a single shape with optional fields.
 * The optionality this replaces never expressed what a given implementation
 * could report — it expressed a property of the entry kind, collapsed into
 * one type because `kind` was an ordinary field. Narrow on `kind` and the
 * fields that exist for that kind are then known to be present:
 *
 * @example
 * const stats = await api.stats("/some/path");
 * if (stats?.kind === "file") {
 *   console.log(stats.size, stats.lastModified); // both `number`
 * }
 */
export type FileStats = FileEntryStats | DirectoryEntryStats;

/** Name and path carried by every entry a `list()` yields. */
export interface FileEntryLocation {
  name: string;
  path: string;
}

/** A file yielded by `list()`. */
export interface FileEntryInfo extends FileEntryStats, FileEntryLocation {}

/** A directory yielded by `list()`. */
export interface DirectoryEntryInfo extends DirectoryEntryStats, FileEntryLocation {}

/**
 * File or directory information returned by `list()`.
 *
 * The same union as {@link FileStats}, plus `name` and `path`, so a listing
 * consumer narrows per entry exactly as a `stats()` consumer does.
 */
export type FileInfo = FileEntryInfo | DirectoryEntryInfo;

/**
 * Cross-platform filesystem abstraction interface.
 *
 * All paths are virtual paths using forward slashes and starting with "/".
 * Implementations handle mapping to underlying storage.
 */
export interface FilesApi {
  /**
   * Read file content as an async iterable of chunks.
   * Returns empty iterable for non-existent files.
   */
  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array>;

  /**
   * Write content to a file, creating parent directories as needed.
   * Overwrites existing file content.
   */
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;

  /**
   * Create `path` with `content` only if nothing exists there, atomically: of two
   * concurrent calls for one path, at most one returns true. Returns false, and writes no
   * file, when the path already exists, whether as a file, a directory or a link.
   * Parent directories are created as needed, and may be left created even when the call
   * returns false. If the content fails part way, the file is removed again and the
   * error is thrown.
   *
   * Only the creation is atomic, not the content: on some backends (node) the file is
   * visible while its content is written, so a reader can see it empty or partial until
   * the call completes. Callers that need readers to see the whole content at once
   * should create a temporary file and `move` it into place.
   *
   * This is the primitive behind lock files (git's `index.lock`, `refs/heads/main.lock`):
   * take the lock by creating the file, release it by removing or renaming it.
   *
   * OPTIONAL. Storages that cannot create atomically leave it out, so code written
   * against an older `FilesApi` keeps compiling and an implementation never claims a
   * guarantee it cannot keep. Callers feature-detect it and choose their own fallback:
   *
   * @example
   * if (!api.createExclusive) throw new Error("this storage cannot hold a lock");
   * const locked = await api.createExclusive("/repo/.git/index.lock", [bytes]);
   * if (!locked) throw new Error("index.lock exists: another process holds the lock");
   *
   * How far the exclusion reaches depends on the implementation, and each one
   * documents it: an in-memory store excludes callers sharing that instance, a local
   * filesystem every process on the machine, the browser every tab and worker of the
   * origin, a database every connection to it, an object store every client of the
   * bucket. Two different `FilesApi` instances over the same storage exclude each other
   * only as far as that reach extends.
   */
  createExclusive?(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<boolean>;

  /**
   * Create a directory and all parent directories.
   * No-op if directory already exists.
   */
  mkdir(path: string): Promise<void>;

  /**
   * List directory contents.
   * Returns empty iterable for non-existent or non-directory paths.
   *
   * Entries are yielded in strictly increasing path order, compared by
   * Unicode code point (`comparePaths`) — the same for recursive and
   * non-recursive listings. `options.after` resumes after a given path.
   */
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo>;

  /**
   * Get file or directory metadata.
   * Returns undefined for non-existent paths.
   */
  stats(path: string): Promise<FileStats | undefined>;

  /**
   * Check if a path exists.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Remove a file or directory (recursively).
   * Returns true if something was removed, false if path didn't exist.
   */
  remove(path: string): Promise<boolean>;

  /**
   * Move/rename a file or directory, with everything under it, creating the target's
   * parent directories as needed. Returns true on success, and false when nothing was
   * changed: the source does not exist, or the backend refused the target (below).
   *
   * @example
   * // Publish a new index: write a lock file, then move it over the real one.
   * await files.write("/repo/.git/index.lock", [bytes]);
   * await files.move("/repo/.git/index.lock", "/repo/.git/index");
   *
   * An existing FILE at the target is replaced. That is the pattern above, and every
   * implementation supports it.
   *
   * An existing DIRECTORY at the target is backend specific. Filesystem-like backends
   * follow POSIX `rename(2)`: node, mem and the browser replace an EMPTY directory with
   * a directory, and return false, changing nothing, for a directory onto a non-empty
   * directory, a file onto a directory, a directory onto a file, or a directory into
   * its own subtree. The sqlite backends replace the target's whole subtree, and throw
   * when one path contains the other. Portable callers do not move onto directories.
   *
   * ATOMICITY. Where the backend allows it, a move is atomic: a reader sees the old
   * state or the new one, never the target missing or partial, and a failed move
   * changes nothing. That holds for node (`rename(2)`), mem (one synchronous step),
   * sqlite (one transaction) and the browser where the native `FileSystemHandle.move()`
   * exists (Chromium, OPFS). It does NOT hold where the move is a copy then a delete:
   * s3 (no rename), the browser without native move, a `CompositeFilesApi` move across
   * mounts, and http/rpc clients, which inherit whatever the server's backend does.
   *
   * PARTIAL FAILURE of a copy-then-delete move: if the copy fails, the error is thrown
   * and the source is kept (the target may hold part of a directory copy; a single file
   * is replaced whole or not at all on the browser). If the copy succeeds but deleting
   * the source fails, the delete is retried once and then a `MoveIncompleteError` is
   * thrown: the target already holds the new content and the source still exists.
   * False is never returned for a half-done move.
   */
  move(source: string, target: string): Promise<boolean>;

  /**
   * Copy a file or directory (recursively).
   * Returns true on success, false if source doesn't exist.
   */
  copy(source: string, target: string): Promise<boolean>;
}
