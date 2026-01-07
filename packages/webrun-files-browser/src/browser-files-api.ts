/**
 * Browser implementation of FilesApi using the File System Access API.
 *
 * Provides a filesystem-like interface over browser's FileSystemDirectoryHandle.
 * Works with directories obtained via showDirectoryPicker() or OPFS.
 */

import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { basename, dirname, joinPath, normalizePath } from "@statewalker/webrun-files";

export interface BrowserFilesApiOptions {
  /**
   * Root FileSystemDirectoryHandle to use as the filesystem root.
   * Can be obtained via showDirectoryPicker(), navigator.storage.getDirectory(), etc.
   */
  rootHandle: FileSystemDirectoryHandle;
}

/**
 * Browser filesystem implementation using the File System Access API.
 *
 * Provides FilesApi interface over browser's FileSystemDirectoryHandle.
 * This enables web applications to read/write files in user-selected directories
 * or the Origin Private File System (OPFS).
 */
export class BrowserFilesApi implements FilesApi {
  private rootHandle: FileSystemDirectoryHandle;

  constructor(options: BrowserFilesApiOptions) {
    this.rootHandle = options.rootHandle;
  }

  private async getDirectoryHandle(
    path: string,
    options: { create?: boolean } = {},
  ): Promise<FileSystemDirectoryHandle | null> {
    const segments = path.split("/").filter((s) => s.length > 0);
    let current = this.rootHandle;

    for (const segment of segments) {
      try {
        current = await current.getDirectoryHandle(segment, options);
      } catch {
        return null;
      }
    }

    return current;
  }

  private async getFileHandle(
    path: string,
    options: { create?: boolean } = {},
  ): Promise<FileSystemFileHandle | null> {
    const normalized = normalizePath(path);
    const parentPath = dirname(normalized);
    const fileName = basename(normalized);

    const parent = await this.getDirectoryHandle(parentPath, options);
    if (!parent) return null;

    try {
      return await parent.getFileHandle(fileName, options);
    } catch {
      return null;
    }
  }

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const fileHandle = await this.getFileHandle(path);
    if (!fileHandle) return;

    try {
      const file = await fileHandle.getFile();
      const start = options?.start ?? 0;
      const length = options?.length;
      const end = length !== undefined ? start + length : file.size;

      if (start >= file.size) return;

      const bufferSize = 8192;
      let position = start;
      const actualEnd = Math.min(end, file.size);

      while (position < actualEnd) {
        const remaining = actualEnd - position;
        const toRead = Math.min(bufferSize, remaining);
        const slice = file.slice(position, position + toRead);
        const buffer = await slice.arrayBuffer();
        yield new Uint8Array(buffer);
        position += buffer.byteLength;
      }
    } catch {
      return;
    }
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const normalized = normalizePath(path);
    const parentPath = dirname(normalized);
    const fileName = basename(normalized);

    const parent = await this.getDirectoryHandle(parentPath, { create: true });
    if (!parent) {
      throw new Error(`Cannot create directory: ${parentPath}`);
    }

    const fileHandle = await parent.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();

    try {
      for await (const chunk of content) {
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
      }
    } finally {
      await writable.close();
    }
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    await this.getDirectoryHandle(normalized, { create: true });
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const normalized = normalizePath(path);
    const dirHandle = await this.getDirectoryHandle(normalized);
    if (!dirHandle) return;

    const recursive = options?.recursive ?? false;

    for await (const [name, handle] of dirHandle.entries()) {
      const entryPath = joinPath(normalized, name);
      const isDirectory = handle.kind === "directory";

      const info: FileInfo = {
        kind: isDirectory ? "directory" : "file",
        name,
        path: entryPath,
        lastModified: 0,
      };

      if (!isDirectory) {
        try {
          const fileHandle = handle as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          info.size = file.size;
          info.lastModified = file.lastModified;
        } catch {
          // Ignore errors getting file metadata
        }
      }

      yield info;

      if (recursive && isDirectory) {
        yield* this.list(entryPath, options);
      }
    }
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const normalized = normalizePath(path);

    if (normalized === "/") {
      return {
        kind: "directory",
        lastModified: 0,
      };
    }

    // Try as file first
    const fileHandle = await this.getFileHandle(normalized);
    if (fileHandle) {
      try {
        const f = await fileHandle.getFile();
        return {
          kind: "file",
          size: f.size,
          lastModified: f.lastModified,
        };
      } catch {
        return undefined;
      }
    }

    // Try as directory
    const dirHandle = await this.getDirectoryHandle(normalized);
    if (dirHandle) {
      return {
        kind: "directory",
        lastModified: 0,
      };
    }

    return undefined;
  }

  async exists(path: string): Promise<boolean> {
    const stats = await this.stats(path);
    return stats !== undefined;
  }

  async remove(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const parentPath = dirname(normalized);
    const name = basename(normalized);

    const parent = await this.getDirectoryHandle(parentPath);
    if (!parent) return false;

    try {
      await parent.removeEntry(name, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async move(source: string, target: string): Promise<boolean> {
    const copied = await this.copy(source, target);
    if (!copied) return false;
    return this.remove(source);
  }

  async copy(source: string, target: string): Promise<boolean> {
    const sourcePath = normalizePath(source);
    const targetPath = normalizePath(target);

    const sourceStats = await this.stats(source);
    if (!sourceStats) return false;

    if (sourceStats.kind === "file") {
      // Copy single file
      const sourceHandle = await this.getFileHandle(sourcePath);
      if (!sourceHandle) return false;

      const sourceFile = await sourceHandle.getFile();

      const targetParentPath = dirname(targetPath);
      const targetFileName = basename(targetPath);

      const targetParent = await this.getDirectoryHandle(targetParentPath, { create: true });
      if (!targetParent) return false;

      const targetHandle = await targetParent.getFileHandle(targetFileName, { create: true });
      const writable = await targetHandle.createWritable();

      try {
        const reader = sourceFile.stream().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
        }
      } finally {
        await writable.close();
      }

      return true;
    }

    // Copy directory recursively
    await this.getDirectoryHandle(targetPath, { create: true });

    for await (const entry of this.list(source, { recursive: true })) {
      if (entry.kind === "directory") continue;

      const relativePath = entry.path.substring(sourcePath.length);
      const newTargetPath = targetPath + relativePath;

      const entryHandle = await this.getFileHandle(entry.path);
      if (!entryHandle) continue;

      const entryFile = await entryHandle.getFile();

      const newTargetParentPath = dirname(newTargetPath);
      const newTargetFileName = basename(newTargetPath);

      const newTargetParent = await this.getDirectoryHandle(newTargetParentPath, { create: true });
      if (!newTargetParent) continue;

      const newTargetHandle = await newTargetParent.getFileHandle(newTargetFileName, {
        create: true,
      });
      const writable = await newTargetHandle.createWritable();

      try {
        const reader = entryFile.stream().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
        }
      } finally {
        await writable.close();
      }
    }

    return true;
  }
}

/**
 * Gets a BrowserFilesApi instance backed by the Origin Private File System (OPFS).
 */
export async function getOPFSFilesApi(): Promise<BrowserFilesApi> {
  const rootHandle = await navigator.storage.getDirectory();
  return new BrowserFilesApi({ rootHandle });
}
