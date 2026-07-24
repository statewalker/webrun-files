import { init as initCjs, parse as parseCjs } from "cjs-module-lexer";
import { init as initEsm, parse as parseEsm } from "es-module-lexer";
import type { SourceFormat } from "../types.js";

const REQUIRE_RE = /require\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;

let esmReady: Promise<unknown> | undefined;
let cjsReady: Promise<unknown> | undefined;

/**
 * List the import specifiers a file's transform will rewrite — the exact same set
 * the ESM/CJS transforms discover — so the server can pre-resolve them (async)
 * before running the synchronous rewrite. For TS/JSX the raw source is scanned;
 * `es-module-lexer` tolerates types well enough to find every specifier.
 */
export async function scanSpecifiers(source: string, format: SourceFormat): Promise<string[]> {
  if (format === "cjs") {
    cjsReady ??= initCjs();
    await cjsReady;
    return [...new Set([...source.matchAll(REQUIRE_RE)].map((m) => m[2]))];
  }
  esmReady ??= initEsm;
  await esmReady;
  const [imports] = parseEsm(source);
  const out = new Set<string>();
  for (const imp of imports) if (imp.n != null) out.add(imp.n);
  return [...out];
}

// re-export so callers can warm the CJS lexer for export detection if needed
export { parseCjs };
