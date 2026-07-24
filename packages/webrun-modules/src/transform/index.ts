import type { PackageManifest, SourceFile, SourceFormat, Transform } from "../types.js";
import { newCjsTransform } from "./transform-cjs.js";
import { newEsmTransform } from "./transform-esm.js";

/** The default per-file transform: dispatch ESM/TS/JSX vs CJS by `file.format`. */
export function newDefaultTransform(): Transform {
  const esm = newEsmTransform();
  const cjs = newCjsTransform();
  return {
    transform(file: SourceFile, rewrite: (specifier: string) => string): Promise<string> {
      return file.format === "cjs" ? cjs.transform(file, rewrite) : esm.transform(file, rewrite);
    },
  };
}

const HAS_ESM = /(^|[\s;])(import|export)[\s{*'"]/;
const HAS_CJS = /(\brequire\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$])/;

/**
 * Decide a file's `SourceFormat` from its extension, the package `type`, and
 * (for ambiguous `.js`) a content sniff. Mirrors Node's resolution: `.mjs`=ESM,
 * `.cjs`=CJS, `.js` follows `package.json#type` then falls back to a syntax sniff.
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
  // .js and anything else: package type wins, else sniff.
  if (manifest?.type === "module") return "esm";
  if (manifest?.type === "commonjs") return "cjs";
  if (HAS_ESM.test(source)) return "esm";
  if (HAS_CJS.test(source)) return "cjs";
  return "esm"; // default to ESM (modern packages, authored source)
}

export { newCjsTransform } from "./transform-cjs.js";
export { newEsmTransform } from "./transform-esm.js";
