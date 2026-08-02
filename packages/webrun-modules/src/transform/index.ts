import type {
  PackageManifest,
  SourceFile,
  SourceFormat,
  Transform,
  TransformResult,
} from "../types.js";
import { newCjsTransform } from "./transform-cjs.js";
import { newEsmTransform } from "./transform-esm.js";

export { analyze } from "./analyze.js";

/** The default per-file transform: dispatch ESM/TS/JSX vs CJS by `file.format`. */
export function newDefaultTransform(): Transform {
  const esm = newEsmTransform();
  const cjs = newCjsTransform();
  return {
    transform(file: SourceFile, rewrite: (specifier: string) => string): Promise<TransformResult> {
      return file.format === "cjs" ? cjs.transform(file, rewrite) : esm.transform(file, rewrite);
    },
  };
}

// `module.exports` / `exports.x` / `exports[…]` are impossible in real ESM — a
// *definitive* CJS signal (unlike the word "export", which appears in CJS files'
// strings/comments, e.g. React's dev warnings).
const CJS_EXPORTS = /\bmodule\.exports\b|\bexports\s*[.[]/;
// A real ESM statement: `import`/`export` as syntax, not a word in prose.
const ESM_STMT = /(^|[\s;])(import|export)[\s{*'"]/;
const REQUIRE_CALL = /(^|[^.\w])require\s*\(/;

/**
 * Decide a file's `SourceFormat` from its extension, the package `type`, and
 * (for ambiguous `.js`) a content sniff. Mirrors Node: `.mjs`=ESM, `.cjs`=CJS,
 * `.js` follows `package.json#type`; with no `type`, a package `.js` is CJS
 * (Node's default) unless real ESM syntax is present. Definitive CJS markers
 * (`module.exports`/`exports.x`) win over a loose `import`/`export` word-match,
 * so a CJS file with "export" in a string is not mis-read as ESM.
 */
export function detectFormat(
  path: string,
  source: string,
  manifest?: PackageManifest,
): SourceFormat {
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return "tsx";
  if (path.endsWith(".mjs")) return "esm";
  if (path.endsWith(".cjs")) return "cjs";
  if (manifest?.type === "module") return "esm";
  if (manifest?.type === "commonjs") return "cjs";
  if (CJS_EXPORTS.test(source)) return "cjs"; // definitive CJS
  if (ESM_STMT.test(source)) return "esm"; // real import/export syntax
  if (REQUIRE_CALL.test(source)) return "cjs"; // weaker CJS hint
  // Node default: a package `.js` with no `type:module` is CJS; authored source
  // (no manifest) defaults to ESM.
  return manifest ? "cjs" : "esm";
}

export { newCjsTransform } from "./transform-cjs.js";
export { newEsmTransform } from "./transform-esm.js";
