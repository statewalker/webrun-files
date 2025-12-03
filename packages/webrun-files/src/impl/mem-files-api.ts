/**
 * In-memory implementation of IFilesApi for testing
 */

import type {
  AppendOptions,
  BinaryStream,
  FileHandle,
  FileInfo,
  FileRef,
  IFilesApi,
  ListOptions,
  ReadStreamOptions,
  WriteStreamOptions,
} from "../types.js";
import { toBinaryAsyncIterable } from "../utils/collect-stream.js";
import { basename, joinPath, resolveFileRef } from "../utils/index.js";

interface FileEntry {
  kind: "file";
  content: Uint8Array;
  lastModified: number;
}

interface DirEntry {
  kind: "directory";
  lastModified: number;
}

type Entry = FileEntry | DirEntry;

class MemFileHandle implements FileHandle {
  constructor(
    private store: Map<string, Entry>,
    private path: string,
  ) {}

  get size(): number {
    const entry = this.store.get(this.path);
    if (entry?.kind === "file") {
      return entry.content.length;
    }
    return 0;
  }

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

  async close(): Promise<void> {
    // No-op for memory implementation
  }

  async appendFile(data: BinaryStream, options: AppendOptions = {}): Promise<number> {
    const file = this.getOrCreateFile();
    const chunks: Uint8Array[] = [file.content];
    let bytesWritten = 0;

    for await (const chunk of toBinaryAsyncIterable(data)) {
      if (options.signal?.aborted) {
        throw new Error("Operation aborted");
      }
      chunks.push(chunk);
      bytesWritten += chunk.length;
    }

    // Merge all chunks
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

  async createWriteStream(data: BinaryStream, options: WriteStreamOptions = {}): Promise<number> {
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

    for await (const chunk of toBinaryAsyncIterable(data)) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      chunks.push(chunk);
      bytesWritten += chunk.length;
    }

    // Merge all chunks
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
}

export class MemFilesApi implements IFilesApi {
  private store = new Map<string, Entry>();

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

    // Check if it's an implicit directory (root always exists)
    if (normalized === "/") {
      return {
        kind: "directory",
        name: "",
        path: "/",
        lastModified: 0,
      };
    }

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

  async open(file: FileRef): Promise<FileHandle> {
    const normalized = resolveFileRef(file);
    return new MemFileHandle(this.store, normalized);
  }

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
