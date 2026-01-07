/**
 * FilesApi wrapper class providing convenience methods on top of IFilesApi.
 *
 * This wrapper serves two purposes:
 * 1. Provides higher-level convenience methods (exists, read, write, readFile)
 *    that combine multiple low-level operations.
 * 2. Implements fallback logic for optional IFilesApi methods (copy, move, mkdir)
 *    when the underlying implementation doesn't provide optimized versions.
 *
 * The wrapper pattern allows application code to use a consistent API regardless
 * of whether the underlying implementation supports native operations.
 */

import type {
  BinaryStream,
  CopyOptions,
  FileHandle,
  FileInfo,
  FileRef,
  IFilesApi,
  ListOptions,
  ReadStreamOptions,
} from "./types.js";
import { resolveFileRef } from "./utils/index.js";
import { joinPath } from "./utils/path-utils.js";

/**
 * Placeholder filename used to create directories in implementations
 * that don't support explicit directory creation (e.g., S3-like backends).
 */
const IGNORE_FILE = ".ignore";

/**
 * High-level filesystem wrapper providing convenience methods and fallback implementations.
 *
 * Wraps any IFilesApi implementation and adds:
 * - `exists()` - Check if a path exists
 * - `read()` - Stream file content with auto-close
 * - `write()` - Write content with auto-close
 * - `readFile()` - Read entire file into memory
 * - Fallback implementations for copy/move/mkdir when not natively supported
 */
export class FilesApi implements IFilesApi {
  /**
   * Creates a new FilesApi wrapper.
   * @param fs - The underlying IFilesApi implementation to wrap.
   */
  constructor(private fs: IFilesApi) {}

  // ========================================
  // IFilesApi delegation
  // These methods delegate directly to the underlying implementation.
  // ========================================

  /** @inheritdoc */
  list(file: FileRef, options?: ListOptions): AsyncGenerator<FileInfo> {
    return this.fs.list(file, options);
  }

  /** @inheritdoc */
  stats(file: FileRef): Promise<FileInfo | undefined> {
    return this.fs.stats(file);
  }

  /** @inheritdoc */
  remove(file: FileRef): Promise<boolean> {
    return this.fs.remove(file);
  }

  /** @inheritdoc */
  open(file: FileRef): Promise<FileHandle> {
    return this.fs.open(file);
  }

  // ========================================
  // Convenience methods built on core API
  // These methods simplify common patterns by handling resource cleanup.
  // ========================================

  /**
   * Checks if a file or directory exists.
   * @param file - Path to check.
   * @returns True if the path exists, false otherwise.
   */
  async exists(file: FileRef): Promise<boolean> {
    const info = await this.stats(file);
    return info !== undefined;
  }

  /**
   * Reads file content as a stream with automatic handle cleanup.
   *
   * Handles the common pattern of opening a file, streaming its content,
   * and ensuring the handle is closed even if an error occurs.
   *
   * @param file - Path to the file to read.
   * @param options - Range options (start/end) and abort signal.
   * @yields Uint8Array chunks of file content.
   */
  async *read(file: FileRef, options: ReadStreamOptions = {}): AsyncGenerator<Uint8Array> {
    const handle = await this.open(file);
    try {
      yield* handle.createReadStream(options);
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes content to a file with automatic handle cleanup.
   *
   * Creates the file and parent directories if they don't exist.
   * Replaces existing file content entirely.
   *
   * @param file - Path to write to.
   * @param content - Binary data to write (streamed for memory efficiency).
   */
  async write(file: FileRef, content: BinaryStream): Promise<void> {
    const handle = await this.open(file);
    try {
      await handle.createWriteStream(content);
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads entire file into a single buffer.
   *
   * Use this for small files that fit in memory. For large files,
   * prefer `read()` to process content as a stream.
   *
   * @param file - Path to the file to read.
   * @returns The complete file content as a single Uint8Array.
   */
  async readFile(file: FileRef): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    for await (const chunk of this.read(file)) {
      chunks.push(chunk);
      totalLength += chunk.length;
    }

    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  // ========================================
  // Methods with native optimization + fallback
  // These use optimized native operations when available,
  // falling back to generic implementations otherwise.
  // ========================================

  /**
   * Copies file or directory.
   *
   * Uses native implementation if available (e.g., Node.js fs.cp, S3 CopyObject)
   * for better performance. Falls back to read/write streaming otherwise.
   *
   * @param source - Path to copy from.
   * @param target - Path to copy to.
   * @param options - Copy options (recursive flag).
   * @returns True if the copy succeeded, false if source doesn't exist.
   */
  async copy(source: FileRef, target: FileRef, options: CopyOptions = {}): Promise<boolean> {
    // Try native implementation first
    if (this.fs.copy) {
      return this.fs.copy(source, target, options);
    }

    // Fallback: read from source, write to target
    const sourceInfo = await this.stats(source);
    if (!sourceInfo) return false;

    const sourcePath = resolveFileRef(source);
    const targetPath = resolveFileRef(target);
    const recursive = options.recursive ?? true;

    if (sourceInfo.kind === "directory") {
      for await (const entry of this.list(source, { recursive })) {
        if (entry.kind === "directory") continue;
        const suffix = entry.path.substring(sourcePath.length);
        const newTargetPath = targetPath + suffix;
        await this.write(newTargetPath, this.read(entry.path));
      }
    } else {
      await this.write(targetPath, this.read(sourcePath));
    }

    return true;
  }

  /**
   * Moves file or directory.
   *
   * Uses native implementation if available (e.g., Node.js fs.rename)
   * for atomic moves on the same filesystem. Falls back to copy+delete otherwise,
   * which is not atomic but works across different filesystems.
   *
   * @param source - Path to move from.
   * @param target - Path to move to.
   * @returns True if the move succeeded, false if source doesn't exist.
   */
  async move(source: FileRef, target: FileRef): Promise<boolean> {
    // Try native implementation first
    if (this.fs.move) {
      return this.fs.move(source, target);
    }

    // Fallback: copy then delete
    const copied = await this.copy(source, target);
    if (!copied) return false;
    await this.remove(source);
    return true;
  }

  /**
   * Creates a directory (and parent directories if needed).
   *
   * Uses native implementation if available. Falls back to creating a
   * placeholder file inside the directory, which works for backends
   * that create directories implicitly (like S3).
   *
   * @param file - Path to the directory to create.
   */
  async mkdir(file: FileRef): Promise<void> {
    // Try native implementation first
    if (this.fs.mkdir) {
      return this.fs.mkdir(file);
    }

    // Fallback: create a placeholder file to establish the directory
    const dirPath = resolveFileRef(file);
    const placeholderPath = joinPath(dirPath, IGNORE_FILE);
    await this.write(placeholderPath, [new Uint8Array(0)]);
  }
}
