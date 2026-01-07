/**
 * Utilities for opening and managing browser file system access.
 *
 * Provides functions for permission verification, handle accessibility checking,
 * and opening directory pickers with optional persistent storage support.
 */

import { BrowserFilesApi } from "./browser-files-api.js";

/**
 * Extended FileSystemHandle interface with permission methods.
 * These are part of the File System Access API but not fully typed in TypeScript's lib.dom.d.ts.
 */
interface FileSystemHandleWithPermissions {
  queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}

/**
 * Options for opening a browser files API with persistent storage support.
 */
export interface OpenBrowserFilesApiOptions {
  /**
   * Key used to store the directory handler in persistent storage.
   * @default "root-dir"
   */
  handlerKey?: string;
  /**
   * Whether to request read-write access (true) or read-only (false).
   * @default true
   */
  readwrite?: boolean;
  /**
   * Gets a stored directory handler by key.
   * @default Returns undefined (no persistence)
   */
  get?: (key: string) => Promise<FileSystemDirectoryHandle | undefined>;
  /**
   * Stores a directory handler with a key.
   * @default No-op (no persistence)
   */
  set?: (key: string, handler: FileSystemDirectoryHandle) => Promise<void>;
  /**
   * Deletes a stored directory handler by key.
   * @default No-op (no persistence)
   */
  del?: (key: string) => Promise<void>;
}

/**
 * Checks if a file system handle is still accessible by performing a real read operation.
 * Handles may become inaccessible if the underlying file/directory was moved or deleted.
 *
 * @param fileHandle - The file or directory handle to check
 * @returns True if the handle is accessible, false otherwise
 */
export async function isHandlerAccessible(
  fileHandle: FileSystemFileHandle | FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    if (fileHandle.kind === "file") {
      await (fileHandle as FileSystemFileHandle).getFile();
    } else {
      // For directories, iterate to check accessibility
      for await (const _item of (fileHandle as FileSystemDirectoryHandle).values()) {
        break;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies and requests file system permissions for a handle.
 * First checks if permission was already granted, then requests if needed.
 *
 * @param fileHandle - The file or directory handle to verify permissions for
 * @param readWrite - Whether to request read-write access (true) or read-only (false)
 * @returns True if permission is granted, false otherwise
 */
export async function verifyPermission(
  fileHandle: FileSystemFileHandle | FileSystemDirectoryHandle,
  readWrite: boolean = false,
): Promise<boolean> {
  const handle = fileHandle as unknown as FileSystemHandleWithPermissions;
  const options: { mode?: "read" | "readwrite" } = {};
  if (readWrite) {
    options.mode = "readwrite";
  }

  // Check if permission was already granted
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }

  // Request permission if not already granted
  if ((await handle.requestPermission(options)) === "granted") {
    return true;
  }

  return false;
}

/**
 * Opens a browser directory picker and returns a BrowserFilesApi instance.
 * Only works in secure contexts (HTTPS) and requires user gesture.
 *
 * Supports persistent storage of directory handles via optional get/set/del functions.
 * When persistence is configured, will attempt to reuse a previously selected directory.
 *
 * @param options - Configuration options for opening the files API
 * @returns A BrowserFilesApi instance for the selected directory
 * @throws Error if access is not granted or the directory is not accessible
 */
export async function openBrowserFilesApi(
  options: OpenBrowserFilesApiOptions = {},
): Promise<BrowserFilesApi> {
  const {
    handlerKey = "root-dir",
    readwrite = true,
    get = async () => undefined,
    set = async () => {},
    del = async () => {},
  } = options;

  let rootHandle = await get(handlerKey);

  if (!rootHandle) {
    // Cast to any since TypeScript's lib.dom.d.ts may not include showDirectoryPicker
    rootHandle = await (
      globalThis as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker();
    await set(handlerKey, rootHandle);
  }

  if (!(await verifyPermission(rootHandle, readwrite))) {
    throw new Error("Access was not granted");
  }

  if (!(await isHandlerAccessible(rootHandle))) {
    await del(handlerKey);
    throw new Error("Cannot access the folder. Please try again.");
  }

  return new BrowserFilesApi({ rootHandle });
}
