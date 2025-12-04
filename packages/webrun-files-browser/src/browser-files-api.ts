/**
 * Browser implementation of IFilesApi using the File System Access API.
 *
 * Provides a filesystem-like interface over browser's FileSystemDirectoryHandle.
 * Works with directories obtained via showDirectoryPicker() or OPFS.
 */

import type {
  CopyOptions,
  FileHandle,
  FileInfo,
  FileRef,
  IFilesApi,
  ListOptions,
} from "@statewalker/webrun-files";
import { basename, dirname, joinPath, resolveFileRef } from "@statewalker/webrun-files";
import { BrowserFileHandle } from "./browser-file-handle.js";

export interface BrowserFilesApiOptions {
  /**
   * Root FileSystemDirectoryHandle to use as the filesystem root.
   * Can be obtained via showDirectoryPicker(), navigator.storage.getDirectory(), etc.
   */
  rootHandle: FileSystemDirectoryHandle;
}

export class BrowserFilesApi implements IFilesApi {
  private rootHandle: FileSystemDirectoryHandle;

  constructor(options: BrowserFilesApiOptions) {
    this.rootHandle = options.rootHandle;
  }

  /**
   * Navigates to a directory handle from a path.
   * Returns null if the directory doesn't exist and create is false.
   */
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

  /**
   * Gets a file handle from a path.
   * Returns null if the file doesn't exist and create is false.
   */
  private async getFileHandle(
    path: string,
    options: { create?: boolean } = {},
  ): Promise<FileSystemFileHandle | null> {
    const normalized = resolveFileRef(path);
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

  /**
   * Lists entries in a directory.
   */
  async *list(file: FileRef, options: ListOptions = {}): AsyncGenerator<FileInfo> {
    const normalized = resolveFileRef(file);
    const dirHandle = await this.getDirectoryHandle(normalized);
    if (!dirHandle) return;

    const { recursive = false } = options;

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
          info.type = file.type;
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

  /**
   * Gets file or directory stats.
   */
  async stats(file: FileRef): Promise<FileInfo | undefined> {
    const normalized = resolveFileRef(file);
    const fileName = basename(normalized);

    // Handle root directory
    if (normalized === "/") {
      return {
        kind: "directory",
        name: "",
        path: "/",
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
          name: fileName,
          path: normalized,
          size: f.size,
          lastModified: f.lastModified,
          type: f.type,
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
        name: fileName,
        path: normalized,
        lastModified: 0,
      };
    }

    return undefined;
  }

  /**
   * Removes a file or directory.
   */
  async remove(file: FileRef): Promise<boolean> {
    const normalized = resolveFileRef(file);
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

  /**
   * Opens a file for reading and writing.
   * Creates the file and parent directories if they don't exist.
   */
  async open(file: FileRef): Promise<FileHandle> {
    const normalized = resolveFileRef(file);
    const parentPath = dirname(normalized);
    const fileName = basename(normalized);

    // Ensure parent directory exists
    const parent = await this.getDirectoryHandle(parentPath, { create: true });
    if (!parent) {
      throw new Error(`Cannot create directory: ${parentPath}`);
    }

    // Get or create file
    const fileHandle = await parent.getFileHandle(fileName, { create: true });
    const f = await fileHandle.getFile();

    return new BrowserFileHandle({ fileHandle, initialFile: f });
  }

  /**
   * Creates a directory (and parent directories if needed).
   */
  async mkdir(file: FileRef): Promise<void> {
    const normalized = resolveFileRef(file);
    await this.getDirectoryHandle(normalized, { create: true });
  }

  /**
   * Moves a file or directory using copy + delete.
   * The File System Access API doesn't have a native move operation.
   */
  async move(source: FileRef, target: FileRef): Promise<boolean> {
    const copied = await this.copy(source, target);
    if (!copied) return false;
    return this.remove(source);
  }

  /**
   * Copies a file or directory.
   */
  async copy(source: FileRef, target: FileRef, options: CopyOptions = {}): Promise<boolean> {
    const sourcePath = resolveFileRef(source);
    const targetPath = resolveFileRef(target);
    const { recursive = true } = options;

    const sourceInfo = await this.stats(source);
    if (!sourceInfo) return false;

    if (sourceInfo.kind === "file") {
      // Copy single file
      const sourceHandle = await this.getFileHandle(sourcePath);
      if (!sourceHandle) return false;

      const sourceFile = await sourceHandle.getFile();

      // Create target file
      const targetParentPath = dirname(targetPath);
      const targetFileName = basename(targetPath);

      const targetParent = await this.getDirectoryHandle(targetParentPath, { create: true });
      if (!targetParent) return false;

      const targetHandle = await targetParent.getFileHandle(targetFileName, { create: true });
      const writable = await targetHandle.createWritable();

      try {
        // Stream the file content
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

    // Copy directory
    if (!recursive) return false;

    // Create target directory
    await this.getDirectoryHandle(targetPath, { create: true });

    // Copy all entries recursively
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

      const newTargetHandle = await newTargetParent.getFileHandle(newTargetFileName, { create: true });
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
 * Opens a browser directory picker and returns a BrowserFilesApi instance.
 * Only works in secure contexts (HTTPS) and requires user gesture.
 */
export async function openBrowserFilesApi(): Promise<BrowserFilesApi> {
  // Cast to any since TypeScript's lib.dom.d.ts may not include showDirectoryPicker
  const rootHandle = await (globalThis as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
  return new BrowserFilesApi({ rootHandle });
}

/**
 * Gets a BrowserFilesApi instance backed by the Origin Private File System (OPFS).
 * OPFS provides a sandboxed filesystem that persists between sessions.
 */
export async function getOPFSFilesApi(): Promise<BrowserFilesApi> {
  const rootHandle = await navigator.storage.getDirectory();
  return new BrowserFilesApi({ rootHandle });
}
