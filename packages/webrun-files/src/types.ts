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
   * Move/rename a file or directory.
   * Returns true on success, false if source doesn't exist.
   */
  move(source: string, target: string): Promise<boolean>;

  /**
   * Copy a file or directory (recursively).
   * Returns true on success, false if source doesn't exist.
   */
  copy(source: string, target: string): Promise<boolean>;
}
