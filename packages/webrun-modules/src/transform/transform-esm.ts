import { init, parse } from "es-module-lexer";
import { transform as sucraseTransform } from "sucrase";
import type { SourceFile, Transform } from "../types.js";

let lexerReady: Promise<unknown> | undefined;

/** Strip TS/JSX to plain JS; leave already-ESM JS untouched. */
function toJs(file: SourceFile): string {
  if (file.format === "ts" || file.format === "tsx") {
    const transforms: ("typescript" | "jsx")[] =
      file.format === "tsx" ? ["typescript", "jsx"] : ["typescript"];
    return sucraseTransform(file.source, {
      transforms,
      jsxRuntime: "automatic",
      filePath: file.path,
    }).code;
  }
  return file.source;
}

/**
 * The default per-file transform for ESM (and TS/JSX) sources: transpile to plain
 * JS, then rewrite every static/dynamic-string import & re-export specifier in
 * place via `rewrite`, leaving quotes and everything else byte-for-byte intact.
 * Computed dynamic specifiers (no static string) are left untouched.
 */
export function newEsmTransform(): Transform {
  return {
    async transform(file: SourceFile, rewrite: (specifier: string) => string): Promise<string> {
      lexerReady ??= init;
      await lexerReady;
      const js = toJs(file);
      const [imports] = parse(js, file.path);
      let out = js;
      // Splice from the end so earlier offsets stay valid. For static imports the
      // [s,e) span sits *inside* the quotes; for dynamic `import("x")` it *includes*
      // them — detect a leading quote and preserve it either way.
      for (let i = imports.length - 1; i >= 0; i--) {
        const imp = imports[i];
        if (imp.n == null) continue; // computed/dynamic specifier — cannot rewrite statically
        const q = out[imp.s];
        const quoted = q === '"' || q === "'" || q === "`";
        const replacement = quoted ? q + rewrite(imp.n) + q : rewrite(imp.n);
        out = out.slice(0, imp.s) + replacement + out.slice(imp.e);
      }
      return out;
    },
  };
}
