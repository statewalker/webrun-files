/**
 * Node.js implementation of IFilesApi.
 *
 * Wraps the Node.js fs/promises module to provide IFilesApi compatibility.
 * This allows seamless integration with Node.js applications while maintaining
 * the same API used by browser and cloud storage implementations.
 *
 * Key features:
 * - Uses native fs operations for optimal performance
 * - Supports optional rootDir prefix to sandbox operations to a subdirectory
 * - Automatic parent directory creation when opening files for writing
 */

import type * as NodeFS from "node:fs/promises";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import type {
  BinaryStream,
  CopyOptions,
  FileHandle,
  FileInfo,
  FileRef,
  IFilesApi,
  ListOptions,
  ReadStreamOptions,
  WriteStreamOptions,
} from "../types.js";
import { basename, dirname, joinPath, resolveFileRef } from "../utils/index.js";

/**
 * Configuration options for NodeFilesApi.
 */
interface NodeFilesApiOptions {
  /**
   * The Node.js fs/promises module. Passed explicitly to allow mocking in tests
   * and to support different Node.js module resolution strategies.
   */
  fs: typeof NodeFS;
  /**
   * Optional root directory path. When set, all operations are relative to this path.
   * Useful for sandboxing file operations to a specific directory.
   * @example "/var/app/data" - all paths become relative to this directory
   */
  rootDir?: string;
}

/**
 * Adapts Node.js FileHandle to the IFilesApi FileHandle interface.
 *
 * Wraps the native fs.FileHandle and translates between the Node.js API
 * (which uses separate parameters) and our interface (which uses options objects).
 */
class NodeFileHandleWrapper implements FileHandle {
  /**
   * Creates a wrapper around a Node.js file handle.
   * @param handle - The native Node.js file handle.
   * @param _size - Initial file size (updated after write operations).
   */
  constructor(
    private handle: NodeFileHandle,
    private _size: number,
  ) {}

  /** @inheritdoc */
  get size(): number {
    return this._size;
  }

  /**
   * Closes the file handle and releases the file descriptor.
   * Important: Always call this to avoid file descriptor leaks.
   */
  async close(): Promise<void> {
    await this.handle.close();
  }

  /**
   * Streams file content in 8KB chunks.
   *
   * Uses positional reads to avoid the overhead of seeking and to support
   * concurrent access patterns. The chunk size balances memory usage and
   * syscall overhead.
   *
   * @inheritdoc
   */
  async *createReadStream(options: ReadStreamOptions = {}): AsyncGenerator<Uint8Array> {
    const { start = 0, end = Infinity, signal } = options;
    const bufferSize = 8192;

    let position = start;
    const actualEnd = Math.min(end, this._size);

    while (position < actualEnd) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const remaining = actualEnd - position;
      const toRead = Math.min(bufferSize, remaining);
      const buffer = new Uint8Array(toRead);

      const { bytesRead } = await this.handle.read(buffer, 0, toRead, position);
      if (bytesRead === 0) break;

      yield buffer.subarray(0, bytesRead);
      position += bytesRead;
    }
  }

  /**
   * Writes data to the file starting at the specified position.
   *
   * Truncates the file at the start position before writing, which removes
   * any content after start. Content before start is preserved.
   * To append data, use `writeStream(data, { start: this.size })`.
   *
   * @inheritdoc
   */
  async writeStream(data: BinaryStream, options: WriteStreamOptions = {}): Promise<number> {
    const { start = 0, signal } = options;
    let position = start;
    let bytesWritten = 0;

    // Truncate file at start position to remove content after start
    await this.handle.truncate(start);

    for await (const chunk of data) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const { bytesWritten: written } = await this.handle.write(chunk, 0, chunk.length, position);
      position += written;
      bytesWritten += written;
    }

    // Update cached size from actual file stats
    const stat = await this.handle.stat();
    this._size = stat.size;

    return bytesWritten;
  }

  /**
   * Changes file permissions.
   * Delegates directly to Node.js handle.chmod().
   */
  async chmod(mode: number): Promise<void> {
    await this.handle.chmod(mode);
  }

  /**
   * Changes file ownership.
   * Delegates directly to Node.js handle.chown().
   */
  async chown(uid: number, gid: number): Promise<void> {
    await this.handle.chown(uid, gid);
  }

  /**
   * Reads bytes from the file at a specific position.
   *
   * Uses positional read which doesn't affect the file's seek position,
   * allowing safe concurrent reads from different positions.
   *
   * @inheritdoc
   */
  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    // Limit length to what can fit in the buffer at the given offset
    const actualLength = Math.min(length, buffer.length - offset);
    if (actualLength <= 0) {
      return 0;
    }
    const result = await this.handle.read(buffer, offset, actualLength, position);
    return result.bytesRead;
  }
}

/**
 * Node.js filesystem implementation of IFilesApi.
 *
 * Wraps Node.js fs/promises to provide the IFilesApi interface.
 * All paths are virtual (starting with "/") and mapped to real filesystem
 * paths using the configured rootDir.
 */
export class NodeFilesApi implements IFilesApi {
  private fs: typeof NodeFS;
  /** Root directory path prepended to all virtual paths. */
  private rootDir: string;

  /**
   * Creates a new NodeFilesApi instance.
   * @param options - Configuration options including fs module and optional root directory.
   */
  constructor(options: NodeFilesApiOptions) {
    this.fs = options.fs;
    this.rootDir = options.rootDir ?? "";
  }

  /**
   * Converts a virtual path (e.g., "/docs/file.txt") to a real filesystem path.
   * Prepends the rootDir to create the actual path used for fs operations.
   */
  private resolvePath(file: FileRef): string {
    const normalized = resolveFileRef(file);
    return this.rootDir + normalized;
  }

  /**
   * Lists entries in a directory using Node.js readdir.
   *
   * Uses withFileTypes option for efficiency (avoids extra stat calls).
   * Silently returns empty results for non-existent directories.
   *
   * @inheritdoc
   */
  async *list(file: FileRef, options: ListOptions = {}): AsyncGenerator<FileInfo> {
    const dirPath = this.resolvePath(file);
    const { recursive = false } = options;

    try {
      const entries = await this.fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = joinPath(resolveFileRef(file), entry.name);
        const fullPath = this.rootDir + entryPath;

        const info: FileInfo = {
          kind: entry.isDirectory() ? "directory" : "file",
          name: entry.name,
          path: entryPath,
          lastModified: 0,
        };

        // Get full stats for size and mtime
        try {
          const stat = await this.fs.stat(fullPath);
          info.size = stat.size;
          info.lastModified = stat.mtimeMs;
        } catch {
          // Ignore stat errors
        }

        yield info;

        if (recursive && entry.isDirectory()) {
          yield* this.list(entryPath, options);
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable - return empty results
    }
  }

  /**
   * Gets file or directory metadata using Node.js stat.
   *
   * Returns undefined for non-existent paths rather than throwing.
   *
   * @inheritdoc
   */
  async stats(file: FileRef): Promise<FileInfo | undefined> {
    const fullPath = this.resolvePath(file);
    const normalized = resolveFileRef(file);

    try {
      const stat = await this.fs.stat(fullPath);
      return {
        kind: stat.isDirectory() ? "directory" : "file",
        name: basename(normalized),
        path: normalized,
        size: stat.size,
        lastModified: stat.mtimeMs,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Removes a file or directory.
   *
   * Uses fs.rm with recursive option for directories to remove all contents.
   * Uses fs.unlink for files.
   *
   * @inheritdoc
   */
  async remove(file: FileRef): Promise<boolean> {
    const fullPath = this.resolvePath(file);

    try {
      const stat = await this.fs.stat(fullPath);
      if (stat.isDirectory()) {
        await this.fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await this.fs.unlink(fullPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Opens a file for reading and writing.
   *
   * Uses "r+" mode for existing files (read/write) or creates the file
   * if it doesn't exist. Parent directories are created automatically.
   *
   * Note: We can't use "a+" because it doesn't allow truncation.
   * We can't use "w+" because it truncates existing files.
   * So we try "r+" first, and fall back to "w+" for new files.
   *
   * @inheritdoc
   */
  async open(file: FileRef): Promise<FileHandle> {
    const fullPath = this.resolvePath(file);
    const normalized = resolveFileRef(file);

    // Ensure parent directory exists before opening file
    const dir = this.rootDir + dirname(normalized);
    await this.fs.mkdir(dir, { recursive: true });

    let handle: NodeFileHandle;
    let size: number;

    try {
      // Try to open existing file with read/write access
      handle = await this.fs.open(fullPath, "r+");
      const stat = await handle.stat();
      size = stat.size;
    } catch {
      // File doesn't exist, create it with read/write access
      handle = await this.fs.open(fullPath, "w+");
      size = 0;
    }

    return new NodeFileHandleWrapper(handle, size);
  }

  /**
   * Moves a file or directory using Node.js fs.rename.
   *
   * This is an atomic operation on the same filesystem.
   * Ensures target parent directory exists before moving.
   *
   * @inheritdoc
   */
  async move(source: FileRef, target: FileRef): Promise<boolean> {
    const sourcePath = this.resolvePath(source);
    const targetPath = this.resolvePath(target);

    try {
      // Ensure target parent directory exists
      const targetDir = dirname(targetPath);
      await this.fs.mkdir(targetDir, { recursive: true });

      await this.fs.rename(sourcePath, targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copies a file or directory using Node.js fs.cp.
   *
   * Uses native fs.cp for efficient copying with recursive support.
   * Ensures target parent directory exists before copying.
   *
   * @inheritdoc
   */
  async copy(source: FileRef, target: FileRef, options: CopyOptions = {}): Promise<boolean> {
    const sourcePath = this.resolvePath(source);
    const targetPath = this.resolvePath(target);
    const { recursive = true } = options;

    try {
      // Ensure target parent directory exists
      const targetDir = dirname(targetPath);
      await this.fs.mkdir(targetDir, { recursive: true });

      await this.fs.cp(sourcePath, targetPath, { recursive });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a directory and all parent directories.
   *
   * Uses fs.mkdir with recursive option to create all missing directories
   * in the path.
   *
   * @inheritdoc
   */
  async mkdir(file: FileRef): Promise<void> {
    const fullPath = this.resolvePath(file);
    await this.fs.mkdir(fullPath, { recursive: true });
  }
}
