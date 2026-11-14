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

/** A rename cannot replace a mount point (a bind-mounted file) or cross devices. */
const COPY_CODES = new Set(["EBUSY", "EXDEV"]);

const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

/**
 * Move `tmp` over `target`. Normally a rename, so readers see the old file or the new one.
 * On Windows a rename refused because the file is open elsewhere is retried for about a
 * second. A rename refused because `target` is a mount point or on another device (EBUSY,
 * EXDEV) falls back to copying `tmp` into `target` in place, as an in-place write would,
 * then removing `tmp`. Any other failure is thrown and `tmp` is left to the caller.
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
      if (code && COPY_CODES.has(code)) {
        await fs.copyFile(tmp, target);
        await fs.rm(tmp, { force: true });
        return;
      }
      throw error;
    }
  }
}
