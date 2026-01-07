import type {
  FileInfo,
  FilesApi,
  FileStats,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { basename, normalizePath } from "@statewalker/webrun-files";

interface Entry {
  kind: "file" | "directory";
  content?: Uint8Array;
  lastModified: number;
}

export interface MemFilesApiOptions {
  /** Initial files to populate. Keys are paths, values are content. */
  initialFiles?: Record<string, string | Uint8Array>;
}

/**
 * In-memory FilesApi implementation.
 * Useful for testing and development.
 */
export class MemFilesApi implements FilesApi {
  private entries = new Map<string, Entry>();

  constructor(options?: MemFilesApiOptions) {
    // Create root directory
    this.entries.set("/", { kind: "directory", lastModified: Date.now() });

    // Initialize with provided files
    if (options?.initialFiles) {
      for (const [path, content] of Object.entries(options.initialFiles)) {
        const normalizedPath = normalizePath(path);
        const bytes =
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content;
        this.setFile(normalizedPath, bytes);
      }
    }
  }

  private setFile(path: string, content: Uint8Array): void {
    this.ensureParentDirs(path);
    this.entries.set(path, {
      kind: "file",
      content,
      lastModified: Date.now(),
    });
  }

  private ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      if (!this.entries.has(current)) {
        this.entries.set(current, {
          kind: "directory",
          lastModified: Date.now(),
        });
      }
    }
  }

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const normalizedPath = normalizePath(path);
    const entry = this.entries.get(normalizedPath);
    if (!entry || entry.kind !== "file" || !entry.content) {
      return;
    }

    const content = entry.content;
    const start = options?.start ?? 0;
    const length = options?.length;
    const end = length !== undefined ? start + length : content.length;

    if (start >= content.length) {
      return;
    }

    yield content.subarray(start, Math.min(end, content.length));
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const normalizedPath = normalizePath(path);
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    for await (const chunk of content) {
      chunks.push(chunk);
      totalLength += chunk.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    this.setFile(normalizedPath, result);
  }

  async mkdir(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    this.ensureParentDirs(normalizedPath + "/dummy");
    if (!this.entries.has(normalizedPath)) {
      this.entries.set(normalizedPath, {
        kind: "directory",
        lastModified: Date.now(),
      });
    }
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const normalizedPath = normalizePath(path);
    const entry = this.entries.get(normalizedPath);
    if (!entry || entry.kind !== "directory") {
      return;
    }

    const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
    const seen = new Set<string>();

    for (const [entryPath, entryValue] of this.entries) {
      if (!entryPath.startsWith(prefix) || entryPath === normalizedPath) {
        continue;
      }

      const relativePath = entryPath.slice(prefix.length);
      const slashIndex = relativePath.indexOf("/");

      if (slashIndex === -1) {
        // Direct child
        yield {
          name: basename(entryPath),
          path: entryPath,
          kind: entryValue.kind,
          size: entryValue.content?.length,
          lastModified: entryValue.lastModified,
        };
      } else if (options?.recursive) {
        // Recursive listing - yield all descendants
        yield {
          name: basename(entryPath),
          path: entryPath,
          kind: entryValue.kind,
          size: entryValue.content?.length,
          lastModified: entryValue.lastModified,
        };
      } else {
        // Non-recursive: yield only immediate subdirectories once
        const dirName = relativePath.slice(0, slashIndex);
        const dirPath = prefix + dirName;
        if (!seen.has(dirPath)) {
          seen.add(dirPath);
          const dirEntry = this.entries.get(dirPath);
          if (dirEntry) {
            yield {
              name: dirName,
              path: dirPath,
              kind: "directory",
              lastModified: dirEntry.lastModified,
            };
          }
        }
      }
    }
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const normalizedPath = normalizePath(path);
    const entry = this.entries.get(normalizedPath);
    if (!entry) {
      // Check if it's an implicit directory
      const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) {
          return {
            kind: "directory",
            lastModified: 0,
          };
        }
      }
      return undefined;
    }

    return {
      kind: entry.kind,
      size: entry.content?.length,
      lastModified: entry.lastModified,
    };
  }

  async exists(path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    if (this.entries.has(normalizedPath)) {
      return true;
    }
    // Check if it's an implicit directory
    const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  async remove(path: string): Promise<boolean> {
    const normalizedPath = normalizePath(path);
    if (!this.entries.has(normalizedPath)) {
      // Check if it's an implicit directory
      const prefix = normalizedPath + "/";
      let hasChildren = false;
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) {
          hasChildren = true;
          break;
        }
      }
      if (!hasChildren) {
        return false;
      }
    }

    // Remove entry and all children
    const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
    const toDelete: string[] = [normalizedPath];
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.entries.delete(key);
    }

    return true;
  }

  async move(source: string, target: string): Promise<boolean> {
    const normalizedSource = normalizePath(source);
    const normalizedTarget = normalizePath(target);

    if (!(await this.exists(normalizedSource))) {
      return false;
    }

    const copied = await this.copy(normalizedSource, normalizedTarget);
    if (copied) {
      await this.remove(normalizedSource);
    }
    return copied;
  }

  async copy(source: string, target: string): Promise<boolean> {
    const normalizedSource = normalizePath(source);
    const normalizedTarget = normalizePath(target);

    const sourceEntry = this.entries.get(normalizedSource);
    if (!sourceEntry) {
      // Check if it's an implicit directory
      const prefix = normalizedSource + "/";
      let isImplicitDir = false;
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) {
          isImplicitDir = true;
          break;
        }
      }
      if (!isImplicitDir) {
        return false;
      }
      // Copy implicit directory
      await this.mkdir(normalizedTarget);
      for (const [entryPath, entryValue] of this.entries) {
        if (entryPath.startsWith(prefix)) {
          const relativePath = entryPath.slice(normalizedSource.length);
          const newPath = normalizedTarget + relativePath;
          if (entryValue.kind === "file") {
            this.setFile(
              newPath,
              entryValue.content ? new Uint8Array(entryValue.content) : new Uint8Array(0),
            );
          } else {
            await this.mkdir(newPath);
          }
        }
      }
      return true;
    }

    if (sourceEntry.kind === "file") {
      this.setFile(
        normalizedTarget,
        sourceEntry.content ? new Uint8Array(sourceEntry.content) : new Uint8Array(0),
      );
    } else {
      // Copy directory recursively
      await this.mkdir(normalizedTarget);
      const prefix =
        normalizedSource === "/" ? "/" : normalizedSource + "/";
      for (const [entryPath, entryValue] of this.entries) {
        if (entryPath.startsWith(prefix)) {
          const relativePath = entryPath.slice(normalizedSource.length);
          const newPath = normalizedTarget + relativePath;
          if (entryValue.kind === "file") {
            this.setFile(
              newPath,
              entryValue.content ? new Uint8Array(entryValue.content) : new Uint8Array(0),
            );
          } else {
            await this.mkdir(newPath);
          }
        }
      }
    }

    return true;
  }
}
