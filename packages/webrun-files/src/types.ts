/**
 * Type definitions for IFilesApi
 *
 * This module defines the core interfaces for the cross-platform filesystem API.
 * The design prioritizes minimal abstractions that work consistently across
 * Node.js, browsers, and cloud storage backends.
 */

/**
 * Discriminator for filesystem entry types.
 * Only "file" and "directory" are supported to maintain cross-platform compatibility.
 * Symlinks, devices, and other special types are not represented because they lack
 * universal support across all target platforms (especially browsers and S3).
 */
export type FileKind = "file" | "directory";

/**
 * Metadata about a file or directory entry.
 * Represents the common subset of information available across all platforms.
 */
export interface FileInfo {
  /** Whether this entry is a file or directory. */
  kind: FileKind;
  /** The base name of the entry (without path). */
  name: string;
  /** The full path to the entry. Always uses forward slashes and starts with "/". */
  path: string;
  /** MIME type of the file (when available, e.g., from browser File API). */
  type?: string;
  /** Size in bytes. Only meaningful for files; may be undefined for directories. */
  size?: number;
  /** Last modification timestamp in milliseconds since Unix epoch. */
  lastModified: number;
}

/**
 * Reference to a file or directory.
 * Can be a simple path string or an object with a path property.
 * The object form allows extending with additional metadata in future versions.
 */
export type FileRef = string | { path: string };

/**
 * Options for listing directory contents.
 */
export interface ListOptions {
  /** If true, lists all descendants recursively. Default: false (immediate children only). */
  recursive?: boolean;
}

/**
 * Options for copying files or directories.
 */
export interface CopyOptions {
  /** If true, copies directory contents recursively. Default: true for convenience. */
  recursive?: boolean;
}

/**
 * Options for appending data to a file.
 */
export interface AppendOptions {
  /** Signal to abort the operation. Checked between chunks during streaming. */
  signal?: AbortSignal;
}

/**
 * Options for reading file content as a stream.
 */
export interface ReadStreamOptions {
  /** Byte offset to start reading from. Default: 0 (beginning of file). */
  start?: number;
  /** Byte offset to stop reading at (exclusive). Default: Infinity (end of file). */
  end?: number;
  /** Signal to abort the operation. Checked between chunks during streaming. */
  signal?: AbortSignal;
}

/**
 * Options for writing data to a file.
 */
export interface WriteStreamOptions {
  /** Byte offset to start writing at. Content before this position is preserved. Default: 0. */
  start?: number;
  /** Signal to abort the operation. Checked between chunks during streaming. */
  signal?: AbortSignal;
}

/**
 * Binary data source for file operations.
 * Accepts both sync and async iterables to support streaming from various sources.
 * Uses Uint8Array chunks for cross-platform binary data compatibility.
 */
export type BinaryStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * Handle for reading and writing a specific file.
 *
 * FileHandle provides random access operations on a file. The handle must be
 * explicitly closed after use to release resources (especially important for
 * Node.js where file descriptors are limited).
 *
 * Design rationale: Using handles instead of direct read/write methods allows
 * efficient multiple operations on the same file without repeated path resolution
 * and permission checks.
 */
export interface FileHandle {
  /** Current file size in bytes. Updated after write operations. */
  readonly size: number;

  /**
   * Closes the file handle and releases associated resources.
   * Should always be called when done with the handle.
   */
  close(): Promise<void>;

  /**
   * Appends data to the end of the file.
   * @param data - Binary data to append (streamed for memory efficiency).
   * @param options - Optional abort signal for cancellation.
   * @returns Number of bytes written.
   */
  appendFile(data: BinaryStream, options?: AppendOptions): Promise<number>;

  /**
   * Creates an async generator that yields file content as chunks.
   * Uses streaming to handle large files without loading them entirely into memory.
   * @param options - Range options (start/end) and abort signal.
   * @yields Uint8Array chunks of file content.
   */
  createReadStream(options?: ReadStreamOptions): AsyncGenerator<Uint8Array>;

  /**
   * Writes data to the file, truncating any existing content after the start position.
   * Content before the start position is preserved.
   * @param data - Binary data to write (streamed for memory efficiency).
   * @param options - Start position and abort signal.
   * @returns Number of bytes written.
   */
  createWriteStream(data: BinaryStream, options?: WriteStreamOptions): Promise<number>;

  /**
   * Read bytes from the file at a specific position.
   * Enables random access patterns without streaming the entire file.
   *
   * @param buffer - The buffer to read bytes into
   * @param offset - The offset in the buffer to start writing at
   * @param length - The number of bytes to read
   * @param position - The position in the file to start reading from
   * @returns The number of bytes actually read (may be less than length at EOF)
   */
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<number>;

  /**
   * Changes file permissions (Unix-style mode).
   * Optional because not all platforms support permissions (e.g., browsers, S3).
   */
  chmod?(mode: number): Promise<void>;

  /**
   * Changes file ownership (Unix-style uid/gid).
   * Optional because not all platforms support ownership (e.g., browsers, S3).
   */
  chown?(uid: number, gid: number): Promise<void>;
}

/**
 * Core filesystem interface - minimal contract for implementations.
 *
 * IFilesApi defines the essential operations that all filesystem implementations
 * must support. The interface is intentionally minimal to ensure consistent behavior
 * across diverse backends (Node.js fs, browser File System Access API, S3, etc.).
 *
 * Design principles:
 * - Required methods (list, stats, remove, open) represent the absolute minimum
 *   needed for a functional filesystem.
 * - Optional methods (move, copy, mkdir) allow implementations to provide
 *   optimized native operations when available.
 * - All paths use forward slashes and start with "/" for consistency.
 */
export interface IFilesApi {
  /**
   * Lists entries in a directory.
   * @param file - Path to the directory to list.
   * @param options - Listing options (recursive flag).
   * @yields FileInfo for each entry in the directory.
   */
  list(file: FileRef, options?: ListOptions): AsyncGenerator<FileInfo>;

  /**
   * Gets metadata about a file or directory.
   * @param file - Path to the file or directory.
   * @returns FileInfo if the entry exists, undefined otherwise.
   */
  stats(file: FileRef): Promise<FileInfo | undefined>;

  /**
   * Removes a file or directory (recursively for directories).
   * @param file - Path to remove.
   * @returns True if something was removed, false if the path didn't exist.
   */
  remove(file: FileRef): Promise<boolean>;

  /**
   * Opens a file for reading and writing.
   * Creates the file and parent directories if they don't exist.
   * @param file - Path to the file to open.
   * @returns A FileHandle for the file.
   */
  open(file: FileRef): Promise<FileHandle>;

  /**
   * Moves a file or directory to a new location.
   * Optional because some backends (e.g., browsers) lack native move support.
   */
  move?(source: FileRef, target: FileRef): Promise<boolean>;

  /**
   * Copies a file or directory.
   * Optional because implementations may need to fall back to read/write.
   */
  copy?(source: FileRef, target: FileRef, options?: CopyOptions): Promise<boolean>;

  /**
   * Creates a directory (and parent directories if needed).
   * Optional because some backends create directories implicitly on file write.
   */
  mkdir?(file: FileRef): Promise<void>;
}
