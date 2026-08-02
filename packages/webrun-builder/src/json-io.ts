import { dirname, type FilesApi, tryReadText, writeText } from "@statewalker/webrun-files";

/** Read a JSON file. Returns `undefined` if missing or unparseable. */
export async function tryReadJson<T>(files: FilesApi, path: string): Promise<T | undefined> {
  const text = await tryReadText(files, path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

let tmpSeq = 0;
/** A per-write temp path. Concurrent writers (e.g. multiple tabs or the CLI on the same
 * folder) must NOT share one `${path}.tmp` — they would clobber each other's temp file
 * and race the rename, corrupting the target. The final rename is last-writer-wins. */
function tempPath(path: string): string {
  tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `${path}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${tmpSeq}.tmp`;
}

/** Atomic JSON write via temp + rename. Creates parent directories if missing. */
export async function writeJsonAtomic(
  files: FilesApi,
  path: string,
  value: unknown,
): Promise<void> {
  const parent = dirname(path);
  if (parent && parent !== "/") await files.mkdir(parent);
  const tmp = tempPath(path);
  await writeText(files, tmp, JSON.stringify(value, null, 2));
  const moved = await files.move(tmp, path);
  if (!moved) {
    await files.remove(tmp).catch(() => {});
    throw new Error(`writeJsonAtomic: failed to rename ${tmp} to ${path}`);
  }
}
