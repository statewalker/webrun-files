import type { SourceFormat } from "../types.js";
import { analyze } from "./analyze.js";

/**
 * List the import specifiers a file's transform will rewrite — the exact same set
 * the ESM/CJS transforms discover — so the server can pre-resolve them (async)
 * before running the synchronous rewrite. Derived from `analyze()`'s descriptor;
 * the reserved `""` key (free globals) is not a specifier and is filtered out.
 */
export async function scanSpecifiers(source: string, format: SourceFormat): Promise<string[]> {
  const { imports } = await analyze(source, format);
  return Object.keys(imports).filter((s) => s !== "");
}
