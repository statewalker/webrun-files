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
import {
  basename,
  dirname,
  joinPath,
  listInPathOrder,
  normalizePath,
  removeMovedSource,
} from "@statewalker/webrun-files";

/** Chrome 110+ exposes move() on FileSystemHandle; not yet in TS DOM types. */
interface MovableHandle extends FileSystemHandle {
  move(destination: FileSystemDirectoryHandle, name: string): Promise<void>;
}

export interface BrowserFilesApiOptions {
  /**
   * Root FileSystemDirectoryHandle to use as the filesystem root.
   * Can be obtained via showDirectoryPicker(), navigator.storage.getDirectory(), etc.
   */
  rootHandle: FileSystemDirectoryHandle;
  /**
   * Names a directory outside the Origin Private File System in the locks
   * `createExclusive` takes, so that separately created `BrowserFilesApi` instances over
   * it exclude each other. Give every instance over the same directory the same value,
   * and different directories different values. Without it, such a directory is named by
   * its handle object (see `createExclusive`). Ignored for a root inside the Origin
   * Private File System: there the lock is named by the file's full path in it.
   */
  lockScope?: string;
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
  private readonly lockScope: string | undefined;
  private lockNamer: Promise<(path: string) => string> | undefined;

  constructor(options: BrowserFilesApiOptions) {
    this.rootHandle = options.rootHandle;
    this.lockScope = options.lockScope;
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

    await this.writeFileIn(parent, fileName, content);
  }

  /**
   * Write `content` to `fileName` in `parent`. A writable stream writes to a swap file:
   * close() commits it, abort() drops it and leaves the old file as it was. So a source
   * that fails part way keeps the old file (and a file this write created is removed
   * again) instead of committing a cut-off one.
   */
  private async writeFileIn(
    parent: FileSystemDirectoryHandle,
    fileName: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const existed = await parent
      .getFileHandle(fileName)
      .then(() => true)
      .catch(() => false);
    const fileHandle = await parent.getFileHandle(fileName, { create: true });
    let writable: FileSystemWritableFileStream | undefined;
    let closing = false;
    try {
      writable = await fileHandle.createWritable();
      for await (const chunk of content) {
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
      }
      closing = true;
      await writable.close();
    } catch (error) {
      if (writable && !closing) await writable.abort().catch(() => {});
      // Remove the empty file this write created, unless someone else has written it since
      // (concurrent writers to one path are otherwise last-close-wins).
      if (!existed) {
        const size = await fileHandle
          .getFile()
          .then((f) => f.size)
          .catch(() => -1);
        if (size === 0) await parent.removeEntry(fileName).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * The File System Access API has no exclusive create, so the check and the create run
   * under a lock named after this directory and the path:
   *
   * - With the Web Locks API (`navigator.locks`, in every current browser), the lock is
   *   shared by all tabs and workers of the origin, so calls from any of them exclude
   *   each other.
   * - Without it (some test environments and polyfills), an in-memory mutex stands in,
   *   which excludes calls within this JavaScript realm only; another tab or worker is
   *   then excluded only by the existence check, which can race.
   *
   * The lock is asked for `ifAvailable`: a call that finds it held returns false at once
   * instead of waiting, since the path is being taken. (Should the holder's content then
   * fail, the path stays free, though this call has returned false.)
   *
   * When the root lies in the Origin Private File System, the lock is named by the file's
   * full path there, `webrun-files:opfs:/repo/HEAD.lock`, so instances rooted at
   * different OPFS directories take the same lock for the same file. Outside it, the
   * lock names the directory by `lockScope` when one was given, else by the handle
   * object, which only instances built on that same object share. Two instances over
   * one picked directory, from separately obtained handles, then exclude each other only
   * through the existence check: pass them the same `lockScope`.
   *
   * Writers that do not take the lock — `write`, or other programs — are not excluded.
   * The file exists, empty, while its content is written, and is removed again if the
   * content fails.
   */
  async createExclusive(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<boolean> {
    const normalized = normalizePath(path);
    if (normalized === "/") return false;
    const parentPath = dirname(normalized);
    const fileName = basename(normalized);
    const lockName = (await this.getLockNamer())(normalized);

    return withLockIfAvailable(lockName, false, async () => {
      const existing = await this.getDirectoryHandle(parentPath);
      if (existing && (await hasEntry(existing, fileName))) return false;
      const parent = existing ?? (await this.getDirectoryHandle(parentPath, { create: true }));
      if (!parent) throw new Error(`Cannot create directory: ${parentPath}`);
      await this.writeFileIn(parent, fileName, content);
      return true;
    });
  }

  /** Names the lock for a normalized path; see {@link createExclusive}. */
  private getLockNamer(): Promise<(path: string) => string> {
    this.lockNamer ??= (async () => {
      try {
        const opfsRoot = await globalThis.navigator?.storage?.getDirectory?.();
        const names = opfsRoot && (await opfsRoot.resolve(this.rootHandle));
        if (names) {
          const rootPath = names.map((name) => `/${name}`).join("");
          return (path: string) => `webrun-files:opfs:${rootPath}${path}`;
        }
      } catch {
        // not available here, or not permitted: fall back to the scope or the handle
      }
      const scope = this.lockScope ?? `handle:${handleId(this.rootHandle)}`;
      return (path: string) => `webrun-files:${scope}:${path}`;
    })();
    return this.lockNamer;
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    await this.getDirectoryHandle(normalized, { create: true });
  }

  /** Directory handles enumerate in no defined order, so the tree is walked in `comparePaths` order. */
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    yield* listInPathOrder(normalizePath(path), (dir) => this.readChildren(dir), options);
  }

  /** A directory's direct entries, in handle order; none if it does not exist. */
  private async readChildren(dir: string): Promise<FileInfo[]> {
    const dirHandle = await this.getDirectoryHandle(dir);
    if (!dirHandle) return [];
    const infos: FileInfo[] = [];
    for await (const [name, handle] of dirHandle.entries()) {
      const entryPath = joinPath(dir, name);
      if (handle.kind === "directory") {
        infos.push({ kind: "directory", name, path: entryPath });
        continue;
      }
      // A file must report both a size and a time, so the `File` behind the
      // handle has to be obtained before the entry can be listed at all.
      // `getFile()` rejects when the entry was removed between the directory
      // read and this call, or when permission was revoked mid-iteration;
      // either way there is no file left to describe, and skipping it is
      // the same answer a listing taken a moment later would have given.
      let file: File;
      try {
        file = await (handle as FileSystemFileHandle).getFile();
      } catch {
        continue;
      }
      infos.push({
        kind: "file",
        name,
        path: entryPath,
        size: file.size,
        lastModified: file.lastModified,
      });
    }
    return infos;
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const normalized = normalizePath(path);

    if (normalized === "/") {
      return { kind: "directory" };
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
      return { kind: "directory" };
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

  /**
   * Uses the native `FileSystemHandle.move()` where it exists (Chromium; atomic in the
   * Origin Private File System), else copies, then deletes the source.
   *
   * - Native move over an existing file: current Chromium replaces the file; versions
   *   that throw instead (the target exists) fall back to the copy below, which still
   *   replaces the target atomically.
   * - Fallback, NOT atomic as a whole: a file is copied through a writable stream,
   *   whose swap file replaces the target's content in one step on close; a directory
   *   is copied file by file. If the copy fails, the error is thrown and the source
   *   kept. If the copy succeeds but the source cannot be deleted, the delete is retried
   *   once, then a `MoveIncompleteError` is thrown: the target already holds the new
   *   content and the source still exists. False is never returned for a half-done move.
   *
   * An existing target is checked first, as POSIX `rename(2)` treats it: a file
   * replaces a file and a directory an empty directory; anything else (a file onto a
   * directory, a directory onto a file or a non-empty directory, a directory into its
   * own subtree) returns false and changes nothing. A move onto itself is a no-op.
   */
  async move(source: string, target: string): Promise<boolean> {
    const sourcePath = normalizePath(source);
    const targetPath = normalizePath(target);

    const sourceStats = await this.stats(sourcePath);
    if (!sourceStats) return false;
    if (sourcePath === targetPath) return true;
    if (sourcePath === "/" || targetPath.startsWith(`${sourcePath}/`)) return false;
    const targetStats = await this.stats(targetPath);
    if (targetStats) {
      if (targetStats.kind !== sourceStats.kind) return false;
      if (targetStats.kind === "directory" && !(await isEmpty(this.list(targetPath)))) {
        return false;
      }
    }

    const sourceHandle: FileSystemHandle | null =
      sourceStats.kind === "file"
        ? await this.getFileHandle(sourcePath)
        : await this.getDirectoryHandle(sourcePath);
    if (!sourceHandle) return false;
    // Fails, creating nothing, when a file stands where a parent directory should be.
    const targetParent = await this.getDirectoryHandle(dirname(targetPath), { create: true });
    if (!targetParent) return false;

    // Native move() (Chrome 110+, Edge 110+): one atomic step in OPFS.
    if (typeof (sourceHandle as MovableHandle).move === "function") {
      try {
        await (sourceHandle as MovableHandle).move(targetParent, basename(targetPath));
        return true;
      } catch {
        // Fall through to copy-then-delete
      }
    }

    if (!(await this.copy(sourcePath, targetPath))) return false;
    await removeMovedSource(this, sourcePath, targetPath);
    return true;
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

      await this.writeFileIn(targetParent, targetFileName, fileChunks(sourceFile));
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

      await this.writeFileIn(newTargetParent, newTargetFileName, fileChunks(entryFile));
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

/** A file's content as chunks, read through its stream (released when stopped early). */
async function* fileChunks(file: File): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // stopped early or done: cancel, so the file's stream does not keep buffering
    await reader.cancel().catch(() => {});
  }
}

/** Whether a listing yields nothing. */
async function isEmpty(entries: AsyncIterable<FileInfo>): Promise<boolean> {
  for await (const _ of entries) return false;
  return true;
}

/** Whether `parent` holds a file or a directory called `name`. */
async function hasEntry(parent: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  for (const get of [
    () => parent.getFileHandle(name),
    () => parent.getDirectoryHandle(name),
  ] as const) {
    try {
      await get();
      return true;
    } catch (error) {
      // A file asked for as a directory, or a directory as a file, is still an entry.
      if ((error as { name?: string })?.name === "TypeMismatchError") return true;
    }
  }
  return false;
}

/** Ids of root handles, for lock names; instances built on one handle object share it. */
const handleIds = new WeakMap<FileSystemDirectoryHandle, string>();

function handleId(handle: FileSystemDirectoryHandle): string {
  let id = handleIds.get(handle);
  if (id === undefined) {
    id = crypto.randomUUID();
    handleIds.set(handle, id);
  }
  return id;
}

/** Names of the in-memory locks standing in for Web Locks that are held now. */
const localLocks = new Set<string>();

/**
 * Run `task` holding the exclusive lock `name`, or return `busy` at once when someone
 * else holds it: a Web Lock asked for `ifAvailable` when `navigator.locks` exists
 * (origin-wide), else an in-memory lock (this realm only).
 */
async function withLockIfAvailable<T>(name: string, busy: T, task: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) {
    return locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) =>
      lock ? task() : busy,
    ) as Promise<T>;
  }

  if (localLocks.has(name)) return busy;
  localLocks.add(name);
  try {
    return await task();
  } finally {
    localLocks.delete(name);
  }
}
