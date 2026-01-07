/**
 * In-memory implementation of IFilesApi.
 *
 * MemFilesApi provides a complete filesystem simulation that stores all data
 * in memory. Primary use cases:
 *
 * - **Unit testing**: Fast, isolated tests without disk I/O or cleanup.
 * - **Development**: Quick prototyping without setting up real storage.
 * - **Sandboxing**: Temporary filesystem that disappears when the process ends.
 *
 * The implementation mirrors real filesystem behavior as closely as possible
 * to ensure tests using MemFilesApi remain valid for other implementations.
 */

import type {
  BinaryStream,
  FileHandle,
  FileInfo,
  FileRef,
  IFilesApi,
  ListOptions,
  ReadStreamOptions,
  WriteStreamOptions,
} from "../types.js";
import { basename, joinPath, resolveFileRef } from "../utils/index.js";

/**
 * Internal representation of a file entry in the memory store.
 */
interface FileEntry {
  kind: "file";
  /** File content stored as a single contiguous buffer. */
  content: Uint8Array;
  /** Last modification timestamp in milliseconds. */
  lastModified: number;
}

/**
 * Internal representation of an explicitly created directory.
 * Note: Directories can also exist implicitly when files have nested paths.
 */
interface DirEntry {
  kind: "directory";
  /** Creation/modification timestamp in milliseconds. */
  lastModified: number;
}

/** Union of all entry types stored in the memory filesystem. */
type Entry = FileEntry | DirEntry;

/**
 * FileHandle implementation for in-memory files.
 *
 * Provides random access to file content stored in the memory map.
 * All operations are synchronous internally but wrapped in Promises
 * to match the FileHandle interface.
 */
class MemFileHandle implements FileHandle {
  /**
   * Creates a handle for accessing a file in the memory store.
   * @param store - Reference to the MemFilesApi's internal storage map.
   * @param path - Normalized path to the file.
   */
  constructor(
    private store: Map<string, Entry>,
    private path: string,
  ) {}

  /** @inheritdoc */
  get size(): number {
    const entry = this.store.get(this.path);
    if (entry?.kind === "file") {
      return entry.content.length;
    }
    return 0;
  }

  /**
   * Gets the file entry, creating an empty file if it doesn't exist.
   * This lazy creation allows opening files for writing before they exist.
   */
  private getOrCreateFile(): FileEntry {
    let entry = this.store.get(this.path);
    if (!entry || entry.kind !== "file") {
      entry = {
        kind: "file",
        content: new Uint8Array(0),
        lastModified: Date.now(),
      };
      this.store.set(this.path, entry);
    }
    return entry;
  }

  /**
   * Closes the file handle.
   * No-op for in-memory files since there are no OS resources to release.
   */
  async close(): Promise<void> {
    // No-op for memory implementation
  }

  /**
   * Streams file content in chunks.
   *
   * Uses 8KB chunks to simulate streaming behavior even though the entire
   * content is already in memory. This ensures consistent behavior with
   * real filesystem implementations where chunked reading is necessary.
   *
   * @inheritdoc
   */
  async *createReadStream(options: ReadStreamOptions = {}): AsyncGenerator<Uint8Array> {
    const entry = this.store.get(this.path);
    if (!entry || entry.kind !== "file") return;

    const { start = 0, end = Infinity, signal } = options;
    const bufferSize = 8192;
    const content = entry.content;
    const actualEnd = Math.min(end, content.length);

    let position = start;

    while (position < actualEnd) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const remaining = actualEnd - position;
      const toRead = Math.min(bufferSize, remaining);

      yield content.subarray(position, position + toRead);
      position += toRead;
    }
  }

  /**
   * Writes data to the file starting at the specified position.
   *
   * Preserves content before the start position and truncates content after.
   * Pads with zeros if start is beyond current file length.
   * To append data, use `writeStream(data, { start: this.size })`.
   *
   * @inheritdoc
   */
  async writeStream(data: BinaryStream, options: WriteStreamOptions = {}): Promise<number> {
    const { start = 0, signal } = options;
    const file = this.getOrCreateFile();

    const chunks: Uint8Array[] = [];
    let bytesWritten = 0;

    // Keep content before start position
    if (start > 0 && file.content.length > 0) {
      chunks.push(file.content.subarray(0, Math.min(start, file.content.length)));
    }

    // Pad with zeros if start is beyond current content
    if (start > file.content.length) {
      chunks.push(new Uint8Array(start - file.content.length));
    }

    for await (const chunk of data) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      chunks.push(chunk);
      bytesWritten += chunk.length;
    }

    // Merge all chunks into a single buffer
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    file.content = merged;
    file.lastModified = Date.now();

    return bytesWritten;
  }

  /**
   * Reads bytes from the file at a specific position.
   *
   * Copies data from the in-memory buffer into the provided buffer.
   * Returns 0 if the file doesn't exist or position is past EOF.
   *
   * @inheritdoc
   */
  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    const entry = this.store.get(this.path);
    if (!entry || entry.kind !== "file") {
      return 0;
    }

    const content = entry.content;
    const available = content.length - position;
    if (available <= 0) {
      return 0;
    }

    const bytesToRead = Math.min(length, available, buffer.length - offset);
    buffer.set(content.subarray(position, position + bytesToRead), offset);
    return bytesToRead;
  }
}

/**
 * In-memory filesystem implementation.
 *
 * Uses a Map to store file and directory entries keyed by their normalized paths.
 * The root directory "/" always exists implicitly.
 *
 * Directory handling:
 * - Directories can be created explicitly via mkdir() or implicitly by creating files.
 * - When listing, implicit directories (inferred from file paths) are included.
 * - The list() method handles both explicit DirEntry and implicit directories.
 */
export class MemFilesApi implements IFilesApi {
  /**
   * Internal storage mapping normalized paths to their entries.
   * Keys are absolute paths like "/foo/bar.txt".
   */
  private store = new Map<string, Entry>();

  /**
   * Lists entries in a directory.
   *
   * Handles both explicit entries stored in the map and implicit directories
   * that are inferred from nested file paths. For example, if "/a/b/c.txt" exists,
   * listing "/" will show directory "a" even if no DirEntry exists for "/a".
   *
   * @inheritdoc
   */
  async *list(file: FileRef, options: ListOptions = {}): AsyncGenerator<FileInfo> {
    const normalized = resolveFileRef(file);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const { recursive = false } = options;

    const seen = new Set<string>();

    for (const [path, entry] of this.store.entries()) {
      if (!path.startsWith(prefix)) continue;

      const relativePath = path.substring(prefix.length);
      const segments = relativePath.split("/");

      if (segments.length === 0 || segments[0] === "") continue;

      if (segments.length === 1) {
        // Direct child file or directory
        if (seen.has(path)) continue;
        seen.add(path);

        const info: FileInfo = {
          kind: entry.kind,
          name: basename(path),
          path,
          lastModified: entry.lastModified,
        };

        if (entry.kind === "file") {
          info.size = entry.content.length;
        }

        yield info;
      } else {
        // This is a nested path
        if (recursive) {
          // Yield all nested entries
          if (seen.has(path)) continue;
          seen.add(path);

          const info: FileInfo = {
            kind: entry.kind,
            name: basename(path),
            path,
            lastModified: entry.lastModified,
          };

          if (entry.kind === "file") {
            info.size = entry.content.length;
          }

          yield info;
        } else {
          // Non-recursive: yield the intermediate directory
          const dirName = segments[0];
          const dirPath = joinPath(normalized, dirName);
          if (!seen.has(dirPath)) {
            seen.add(dirPath);
            yield {
              kind: "directory",
              name: dirName,
              path: dirPath,
              lastModified: 0,
            };
          }
        }
      }
    }
  }

  /**
   * Gets metadata about a file or directory.
   *
   * Returns info for explicit entries, the implicit root directory,
   * and implicit directories inferred from nested file paths.
   *
   * @inheritdoc
   */
  async stats(file: FileRef): Promise<FileInfo | undefined> {
    const normalized = resolveFileRef(file);

    const entry = this.store.get(normalized);
    if (entry) {
      const info: FileInfo = {
        kind: entry.kind,
        name: basename(normalized),
        path: normalized,
        lastModified: entry.lastModified,
      };
      if (entry.kind === "file") {
        info.size = entry.content.length;
      }
      return info;
    }

    // Root directory always exists implicitly
    if (normalized === "/") {
      return {
        kind: "directory",
        name: "",
        path: "/",
        lastModified: 0,
      };
    }

    // Check if it's an implicit directory (has files under it)
    const prefix = `${normalized}/`;
    for (const path of this.store.keys()) {
      if (path.startsWith(prefix)) {
        return {
          kind: "directory",
          name: basename(normalized),
          path: normalized,
          lastModified: 0,
        };
      }
    }

    return undefined;
  }

  /**
   * Removes a file or directory and all its contents.
   *
   * For directories, removes all entries with paths starting with the
   * directory's path prefix. This handles both explicit entries and
   * nested files that create implicit directory structure.
   *
   * @inheritdoc
   */
  async remove(file: FileRef): Promise<boolean> {
    const normalized = resolveFileRef(file);
    const prefix = `${normalized}/`;

    let removed = false;

    // Remove exact match
    if (this.store.delete(normalized)) {
      removed = true;
    }

    // Remove all children (for directories)
    for (const path of [...this.store.keys()]) {
      if (path.startsWith(prefix)) {
        this.store.delete(path);
        removed = true;
      }
    }

    return removed;
  }

  /**
   * Opens a file handle for reading and writing.
   *
   * The file is created lazily when first written to. Unlike real filesystems,
   * parent directories don't need to exist - they're handled implicitly.
   *
   * @inheritdoc
   */
  async open(file: FileRef): Promise<FileHandle> {
    const normalized = resolveFileRef(file);
    return new MemFileHandle(this.store, normalized);
  }

  /**
   * Creates a directory explicitly.
   *
   * While directories exist implicitly when files are created under them,
   * mkdir() creates an explicit DirEntry which can be useful when an
   * empty directory needs to persist.
   *
   * @inheritdoc
   */
  async mkdir(file: FileRef): Promise<void> {
    const normalized = resolveFileRef(file);
    if (!this.store.has(normalized)) {
      this.store.set(normalized, {
        kind: "directory",
        lastModified: Date.now(),
      });
    }
  }
}
