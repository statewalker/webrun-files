/**
 * FilesApi wrapper class providing convenience methods on top of IFilesApi
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
import { toBinaryAsyncIterable } from "./utils/collect-stream.js";
import { joinPath, resolveFileRef } from "./utils/index.js";

const IGNORE_FILE = ".gitkeep";

export class FilesApi implements IFilesApi {
  constructor(private fs: IFilesApi) {}

  // ========================================
  // IFilesApi delegation
  // ========================================

  list(file: FileRef, options?: ListOptions): AsyncGenerator<FileInfo> {
    return this.fs.list(file, options);
  }

  stats(file: FileRef): Promise<FileInfo | undefined> {
    return this.fs.stats(file);
  }

  remove(file: FileRef): Promise<boolean> {
    return this.fs.remove(file);
  }

  open(file: FileRef): Promise<FileHandle> {
    return this.fs.open(file);
  }

  // ========================================
  // Convenience methods built on core API
  // ========================================

  /**
   * Checks if a file or directory exists.
   */
  async exists(file: FileRef): Promise<boolean> {
    const info = await this.stats(file);
    return info !== undefined;
  }

  /**
   * Reads file content as a stream.
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
   * Writes content to a file.
   */
  async write(file: FileRef, content: BinaryStream): Promise<void> {
    const handle = await this.open(file);
    try {
      await handle.createWriteStream(toBinaryAsyncIterable(content));
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads entire file into a single buffer.
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

  /**
   * Copies file or directory.
   * Uses native implementation if available, otherwise falls back to read/write.
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
   * Uses native implementation if available, otherwise falls back to copy+delete.
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
   * Creates a directory.
   * Uses native implementation if available, otherwise creates a placeholder file.
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
