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
}

/**
 * File or directory metadata returned by stats().
 * Simplified type without path information.
 */
export interface FileStats {
  kind: FileKind;
  size?: number;
  lastModified?: number;
}

/**
 * File or directory information returned by list().
 * Includes name and path for directory traversal.
 */
export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size?: number;
  lastModified?: number;
}

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
