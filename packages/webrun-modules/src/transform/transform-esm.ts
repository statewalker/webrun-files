import type { SourceFile, Transform, TransformResult } from "../types.js";
import { parseEsmModule } from "./analyze.js";
import { toJs } from "./to-js.js";

/** Recursively find `import(<literal>)` argument nodes (static-string dynamic
 *  imports). Computed args (BinaryExpression, …) are left untouched. */
function walkDynamicImports(node: any, cb: (arg: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "ImportExpression" && node.source) cb(node.source);
  for (const k of Object.keys(node)) {
    const v = (node as Record<string, unknown>)[k];
    if (Array.isArray(v)) for (const c of v) walkDynamicImports(c, cb);
    else if (v && typeof (v as { type?: unknown }).type === "string") walkDynamicImports(v, cb);
  }
}

/**
 * Transpile TS/JSX to JS, then rewrite every static import/re-export/dynamic-string
 * specifier in place via `rewrite`. acorn gives each specifier string-literal's
 * `[start,end)` (quotes included); we splice from the end so earlier offsets stay
 * valid, preserving the original quote character.
 */
export function newEsmTransform(): Transform {
  return {
    async transform(
      file: SourceFile,
      rewrite: (specifier: string) => string,
    ): Promise<TransformResult> {
      const js = toJs(file.source, file.format, file.path);
      const ast = parseEsmModule(js);
      const spans: { s: number; e: number; value: string }[] = [];
      for (const node of ast.body as any[]) {
        if (
          (node.type === "ImportDeclaration" ||
            node.type === "ExportNamedDeclaration" ||
            node.type === "ExportAllDeclaration") &&
          node.source
        ) {
          spans.push({ s: node.source.start, e: node.source.end, value: node.source.value });
        }
      }
      walkDynamicImports(ast, (arg) => {
        if (arg.type === "Literal" && typeof arg.value === "string") {
          spans.push({ s: arg.start, e: arg.end, value: arg.value });
        }
      });
      spans.sort((a, b) => b.s - a.s); // splice from the end
      let out = js;
      for (const sp of spans) {
        const q = out[sp.s]; // opening quote (start includes it)
        out = out.slice(0, sp.s) + q + rewrite(sp.value) + q + out.slice(sp.e);
      }
      return { code: out };
    },
  };
}
