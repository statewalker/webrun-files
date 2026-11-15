import * as fs from "node:fs/promises";

export interface ReplaceFileOptions {
  /** The rename to use (tests inject failures). */
  rename?: (from: string, to: string) => Promise<void>;
  /** The platform whose rename rules apply (default: `process.platform`). */
  platform?: string;
  /** Delay before the first Windows retry; it doubles each time (default 10 ms). */
  retryDelayMs?: number;
}

/** Windows refuses to replace a file another process holds open; such holds are brief. */
const WIN32_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_RETRIES = 7; // 10 ms doubling: about 1.3 s in all

/**
 * A rename cannot replace a mount point (a bind-mounted file: EBUSY on POSIX) or cross
 * devices (EXDEV). On Windows EBUSY is a sharing violation, retried above, not a mount.
 */
const COPY_CODES = new Set(["EBUSY", "EXDEV"]);
const WIN32_COPY_CODES = new Set(["EXDEV"]);
const COPY_CHUNK = 64 * 1024;

const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

/**
 * Move `tmp` over `target`. Normally a rename, so readers see the old file or the new one.
 * On Windows a rename refused because the file is open elsewhere is retried for about a
 * second. A rename refused because `target` is a mount point or on another device (EBUSY,
 * EXDEV) falls back to copying `tmp` into `target` in place, as an in-place write would:
 * the target keeps its inode, owner and mode (no chmod, no unlink), and a failure part way
 * leaves it partial. Then `tmp` is removed (best effort). Any other failure is thrown and
 * `tmp` is left to the caller.
 */
export async function replaceFile(
  tmp: string,
  target: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const rename = options.rename ?? fs.rename;
  const win32 = (options.platform ?? process.platform) === "win32";
  let delay = options.retryDelayMs ?? 10;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (win32 && code && WIN32_RETRY_CODES.has(code) && attempt < WIN32_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      if (code && (win32 ? WIN32_COPY_CODES : COPY_CODES).has(code)) {
        await copyInto(tmp, target);
        await fs.rm(tmp, { force: true }).catch(() => {}); // the content has landed
        return;
      }
      throw error;
    }
  }
}

/** Overwrite `target` in place with `source` (not `fs.copyFile`, which chmods and unlinks). */
async function copyInto(source: string, target: string): Promise<void> {
  const from = await fs.open(source, "r");
  try {
    const to = await fs.open(target, "r+");
    try {
      const buffer = new Uint8Array(COPY_CHUNK);
      let position = 0;
      for (;;) {
        const { bytesRead } = await from.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await to.write(
            buffer,
            offset,
            bytesRead - offset,
            position + offset,
          );
          offset += bytesWritten;
        }
        position += bytesRead;
      }
      await to.truncate(position);
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}
