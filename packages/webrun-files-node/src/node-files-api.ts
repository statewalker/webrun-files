import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { dirname, joinPath, normalizePath } from "@statewalker/webrun-files";

export interface NodeFilesApiOptions {
  /**
   * Root directory for file operations. All paths are resolved relative to this.
   * Defaults to current working directory if not specified.
   */
  rootDir?: string;
}

/**
 * Node.js FilesApi implementation using fs/promises.
 * Maps virtual paths (starting with /) to the filesystem rooted at rootDir.
 */
export class NodeFilesApi implements FilesApi {
  private rootDir: string;

  constructor(options?: NodeFilesApiOptions) {
    this.rootDir = options?.rootDir ?? process.cwd();
  }

  private resolvePath(virtualPath: string): string {
    const normalized = normalizePath(virtualPath);
    return this.rootDir + normalized;
  }

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const realPath = this.resolvePath(path);

    try {
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        return;
      }

      const handle = await fs.open(realPath, "r");
      try {
        const start = options?.start ?? 0;
        const length = options?.length;
        const end = length !== undefined ? start + length : stat.size;

        if (start >= stat.size) {
          return;
        }

        const bufferSize = 8192;
        let position = start;
        const actualEnd = Math.min(end, stat.size);

        while (position < actualEnd) {
          const remaining = actualEnd - position;
          const toRead = Math.min(bufferSize, remaining);
          const buffer = new Uint8Array(toRead);

          const { bytesRead } = await handle.read(buffer, 0, toRead, position);
          if (bytesRead === 0) break;

          yield buffer.subarray(0, bytesRead);
          position += bytesRead;
        }
      } finally {
        await handle.close();
      }
    } catch {
      // File doesn't exist or can't be read
      return;
    }
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const realPath = this.resolvePath(path);
    const normalized = normalizePath(path);
    const dir = this.rootDir + dirname(normalized);

    await fs.mkdir(dir, { recursive: true });

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

    await fs.writeFile(realPath, result);
  }

  async mkdir(path: string): Promise<void> {
    const realPath = this.resolvePath(path);
    await fs.mkdir(realPath, { recursive: true });
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const realPath = this.resolvePath(path);
    const normalizedPath = normalizePath(path);

    try {
      const entries = await fs.readdir(realPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = joinPath(normalizedPath, entry.name);
        const fullPath = this.resolvePath(entryPath);

        let stat: Stats;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }

        const info: FileInfo = {
          name: entry.name,
          path: entryPath,
          kind: entry.isDirectory() ? "directory" : "file",
          size: stat.size,
          lastModified: stat.mtimeMs,
        };

        yield info;

        if (options?.recursive && entry.isDirectory()) {
          yield* this.list(entryPath, options);
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
      return;
    }
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const realPath = this.resolvePath(path);

    try {
      const stat = await fs.stat(realPath);
      return {
        kind: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        lastModified: stat.mtimeMs,
      };
    } catch {
      return undefined;
    }
  }

  async exists(path: string): Promise<boolean> {
    const realPath = this.resolvePath(path);

    try {
      await fs.access(realPath);
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<boolean> {
    const realPath = this.resolvePath(path);

    try {
      const stat = await fs.stat(realPath);
      if (stat.isDirectory()) {
        await fs.rm(realPath, { recursive: true, force: true });
      } else {
        await fs.unlink(realPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  async move(source: string, target: string): Promise<boolean> {
    const sourcePath = this.resolvePath(source);
    const targetPath = this.resolvePath(target);
    const normalizedTarget = normalizePath(target);

    try {
      await fs.access(sourcePath);
    } catch {
      return false;
    }

    try {
      const targetDir = this.rootDir + dirname(normalizedTarget);
      await fs.mkdir(targetDir, { recursive: true });
      await fs.rename(sourcePath, targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async copy(source: string, target: string): Promise<boolean> {
    const sourcePath = this.resolvePath(source);
    const targetPath = this.resolvePath(target);
    const normalizedTarget = normalizePath(target);

    try {
      await fs.access(sourcePath);
    } catch {
      return false;
    }

    try {
      const targetDir = this.rootDir + dirname(normalizedTarget);
      await fs.mkdir(targetDir, { recursive: true });
      await fs.cp(sourcePath, targetPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}
