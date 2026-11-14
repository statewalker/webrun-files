import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { dirname, joinPath, listInPathOrder, normalizePath } from "@statewalker/webrun-files";

/** Small chunks are gathered up to this size before each write call. */
const WRITE_BATCH = 64 * 1024;

export interface NodeFilesApiOptions {
  /**
   * Root directory for file operations. All paths are resolved relative to this, and a path
   * whose `..` segments would leave it is refused. Defaults to the current working directory.
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
    this.rootDir = nodePath.resolve(options?.rootDir ?? process.cwd());
  }

  /** The real path of a virtual one; throws when `..` segments would take it outside rootDir. */
  private resolvePath(virtualPath: string): string {
    const real = nodePath.resolve(this.rootDir, `.${normalizePath(virtualPath)}`);
    const prefix = this.rootDir.endsWith(nodePath.sep) ? this.rootDir : this.rootDir + nodePath.sep;
    if (real !== this.rootDir && !real.startsWith(prefix)) {
      throw new Error(`NodeFilesApi: path is outside rootDir: ${virtualPath}`);
    }
    return real;
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
    const dir = this.resolvePath(dirname(normalized));

    await fs.mkdir(dir, { recursive: true });

    // Stream into a temporary beside the file, then rename it over the file: memory stays at
    // about one chunk, a source that fails leaves the old file, and a file can be rewritten
    // from its own read. The dot-name keeps directory listings (git refs, objects) from
    // taking a write in flight for a real entry.
    const tmp = nodePath.join(
      nodePath.dirname(realPath),
      `.${nodePath.basename(realPath)}.${crypto.randomUUID()}.tmp`,
    );
    const handle = await fs.open(tmp, "wx");
    let done = false;
    try {
      const batch: Uint8Array[] = [];
      let batched = 0;
      const flush = async () => {
        if (batched === 0) return;
        const bytes = batch.length === 1 ? (batch[0] as Uint8Array) : Buffer.concat(batch);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
          offset += bytesWritten;
        }
        batch.length = 0;
        batched = 0;
      };
      for await (const chunk of content) {
        if (chunk.length === 0) continue;
        batch.push(chunk);
        batched += chunk.length;
        if (batched >= WRITE_BATCH) await flush();
      }
      await flush();
      await handle.close();
      await fs.rename(tmp, realPath);
      done = true;
    } finally {
      if (!done) {
        await handle.close().catch(() => {});
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    const realPath = this.resolvePath(path);
    await fs.mkdir(realPath, { recursive: true });
  }

  /** `readdir` order is unspecified, so the tree is walked in `comparePaths` order. */
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    yield* listInPathOrder(normalizePath(path), (dir) => this.readChildren(dir), options);
  }

  /** A directory's direct entries, in `readdir` order; none if it cannot be read. */
  private async readChildren(dir: string): Promise<FileInfo[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.resolvePath(dir), { withFileTypes: true });
    } catch {
      // Directory doesn't exist or can't be read
      return [];
    }
    const infos: FileInfo[] = [];
    for (const entry of entries) {
      const entryPath = joinPath(dir, entry.name);
      let stat: Stats;
      try {
        stat = await fs.stat(this.resolvePath(entryPath));
      } catch {
        continue;
      }
      infos.push(
        entry.isDirectory()
          ? { name: entry.name, path: entryPath, kind: "directory" }
          : {
              name: entry.name,
              path: entryPath,
              kind: "file",
              size: stat.size,
              lastModified: stat.mtimeMs,
            },
      );
    }
    return infos;
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const realPath = this.resolvePath(path);

    try {
      const stat = await fs.stat(realPath);
      // A directory reports neither size nor time. `stat` supplies both, but
      // the size is the inode's own bookkeeping rather than anything about the
      // contents, and neither is available on every storage, so neither is
      // part of what a consumer may rely on.
      if (stat.isDirectory()) return { kind: "directory" };
      return {
        kind: "file",
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
      const targetDir = this.resolvePath(dirname(normalizedTarget));
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
      const targetDir = this.resolvePath(dirname(normalizedTarget));
      await fs.mkdir(targetDir, { recursive: true });
      await fs.cp(sourcePath, targetPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}
