/**
 * Node.js implementation of IFilesApi
 */

import type * as NodeFS from "node:fs/promises";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import type {
  AppendOptions,
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
import { toBinaryAsyncIterable } from "../utils/collect-stream.js";
import { basename, dirname, joinPath, resolveFileRef } from "../utils/index.js";

interface NodeFilesApiOptions {
  fs: typeof NodeFS;
  rootDir?: string;
}

/**
 * Wraps Node.js FileHandle to implement our FileHandle interface.
 */
class NodeFileHandleWrapper implements FileHandle {
  constructor(
    private handle: NodeFileHandle,
    private _size: number,
  ) {}

  get size(): number {
    return this._size;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async appendFile(data: BinaryStream, options: AppendOptions = {}): Promise<number> {
    let bytesWritten = 0;
    const asyncData = toBinaryAsyncIterable(data);

    for await (const chunk of asyncData) {
      if (options.signal?.aborted) {
        throw new Error("Operation aborted");
      }
      await this.handle.appendFile(chunk);
      bytesWritten += chunk.length;
    }

    // Update size
    const stat = await this.handle.stat();
    this._size = stat.size;

    return bytesWritten;
  }

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

  async createWriteStream(data: BinaryStream, options: WriteStreamOptions = {}): Promise<number> {
    const { start = 0, signal } = options;
    let position = start;
    let bytesWritten = 0;

    const asyncData = toBinaryAsyncIterable(data);

    // Truncate file at start position
    await this.handle.truncate(start);

    for await (const chunk of asyncData) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const { bytesWritten: written } = await this.handle.write(chunk, 0, chunk.length, position);
      position += written;
      bytesWritten += written;
    }

    // Update size
    const stat = await this.handle.stat();
    this._size = stat.size;

    return bytesWritten;
  }

  async chmod(mode: number): Promise<void> {
    await this.handle.chmod(mode);
  }

  async chown(uid: number, gid: number): Promise<void> {
    await this.handle.chown(uid, gid);
  }
}

export class NodeFilesApi implements IFilesApi {
  private fs: typeof NodeFS;
  private rootDir: string;

  constructor(options: NodeFilesApiOptions) {
    this.fs = options.fs;
    this.rootDir = options.rootDir ?? "";
  }

  private resolvePath(file: FileRef): string {
    const normalized = resolveFileRef(file);
    return this.rootDir + normalized;
  }

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
      // Directory doesn't exist or isn't readable
    }
  }

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

  async remove(file: FileRef): Promise<boolean> {
    const fullPath = this.resolvePath(file);

    try {
      const stat = await this.fs.stat(fullPath);
      if (stat.isDirectory()) {
        await this.fs.rm(fullPath, { recursive: true });
      } else {
        await this.fs.unlink(fullPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  async open(file: FileRef): Promise<FileHandle> {
    const fullPath = this.resolvePath(file);
    const normalized = resolveFileRef(file);

    // Ensure parent directory exists
    const dir = this.rootDir + dirname(normalized);
    await this.fs.mkdir(dir, { recursive: true });

    // Open file with read/write access, create if doesn't exist
    const handle = await this.fs.open(fullPath, "a+");
    const stat = await handle.stat();

    return new NodeFileHandleWrapper(handle, stat.size);
  }

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

  async mkdir(file: FileRef): Promise<void> {
    const fullPath = this.resolvePath(file);
    await this.fs.mkdir(fullPath, { recursive: true });
  }
}
