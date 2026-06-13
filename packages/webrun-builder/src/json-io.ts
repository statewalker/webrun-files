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

/** Atomic JSON write via temp + rename. Creates parent directories if missing. */
export async function writeJsonAtomic(
  files: FilesApi,
  path: string,
  value: unknown,
): Promise<void> {
  const parent = dirname(path);
  if (parent && parent !== "/") await files.mkdir(parent);
  const tmp = `${path}.tmp`;
  await writeText(files, tmp, JSON.stringify(value, null, 2));
  const moved = await files.move(tmp, path);
  if (!moved) throw new Error(`writeJsonAtomic: failed to rename ${tmp} to ${path}`);
}
