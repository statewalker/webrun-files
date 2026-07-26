import { init, parse } from "cjs-module-lexer";
import type { SourceFile, Transform } from "../types.js";

let lexerReady: Promise<unknown> | undefined;

// Matches `require("x")` / `require('x')` with a static string literal argument.
const REQUIRE_RE = /require\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Collect the unique static-string `require(...)` specifiers in a CJS source. */
function findRequires(source: string): string[] {
  const set = new Set<string>();
  for (const m of source.matchAll(REQUIRE_RE)) set.add(m[2]);
  return [...set];
}

/**
 * Transform a CommonJS file into served, browser-runnable ESM — no global runtime
 * registry: each static `require` target is a static namespace import, so the ESM
 * module graph itself provides load ordering and circular-dep handling. The CJS
 * body runs synchronously against a synthetic `require` that maps specifiers to
 * those namespaces; named exports (via `cjs-module-lexer`) are re-exported as
 * eval-time snapshots (valid because the body executed synchronously above).
 * Computed `require(expr)` hits the synthetic require's miss path (throws) — the
 * declared `esbuild-wasm` fallback's job.
 */
export function newCjsTransform(): Transform {
  return {
    async transform(file: SourceFile, rewrite: (specifier: string) => string): Promise<string> {
      lexerReady ??= init();
      await lexerReady;

      const specs = findRequires(file.source);
      const importLines: string[] = [];
      const mapEntries: string[] = [];
      specs.forEach((spec, i) => {
        importLines.push(`import * as __d${i} from ${JSON.stringify(rewrite(spec))};`);
        mapEntries.push(`  ${JSON.stringify(spec)}: __d${i},`);
      });

      let names: string[] = [];
      let reexports: string[] = [];
      try {
        const parsed = parse(file.source);
        names = parsed.exports.filter((n) => IDENT_RE.test(n) && n !== "default");
        reexports = parsed.reexports;
      } catch {
        names = []; // lexer can't parse → default-only interop
      }
      const namedExports = [...new Set(names)]
        .map((n) => `export const ${n} = module.exports.${n};`)
        .join("\n");
      // A `module.exports = require("x")` entry (e.g. React's `index.js`) has no
      // own statically-lexable names — only a reexport. Surface x's named exports
      // by re-exporting its already-served namespace, so `import { StrictMode }
      // from "react"` (and the automatic-JSX `jsxDEV` import) resolve. `export *`
      // never re-exports `default`, so the `export default module.exports` above
      // stays authoritative.
      const reexportLines = [...new Set(reexports)]
        .map((spec) => `export * from ${JSON.stringify(rewrite(spec))};`)
        .join("\n");

      const dir = file.path.replace(/\/[^/]*$/, "");
      return [
        ...importLines,
        `const __ns = {\n${mapEntries.join("\n")}\n};`,
        `const module = { exports: {} };`,
        `const require = (s) => {`,
        `  const m = __ns[s];`,
        `  if (!m) throw new Error("Cannot require (computed/unresolved): " + s);`,
        `  return m.default !== undefined ? m.default : m;`,
        `};`,
        `(function (module, exports, require, __filename, __dirname) {`,
        file.source,
        `}).call(module.exports, module, module.exports, require, ${JSON.stringify(file.path)}, ${JSON.stringify(dir)});`,
        `export default module.exports;`,
        namedExports,
        reexportLines,
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}
