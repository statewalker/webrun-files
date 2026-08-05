import { parse as acornParse } from "acorn";
import { init, parse } from "cjs-module-lexer";
import type { SourceFile, Transform, TransformResult } from "../types.js";

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

interface Node {
  type: string;
  start: number;
  end: number;
  [k: string]: unknown;
}

/** `process.env.NODE_ENV` member access. */
function isNodeEnv(n: Node | undefined): boolean {
  if (!n || n.type !== "MemberExpression") return false;
  const env = n.object as Node | undefined;
  const prop = n.property as Node | undefined;
  return (
    prop?.type === "Identifier" &&
    (prop as { name?: string }).name === "NODE_ENV" &&
    env?.type === "MemberExpression" &&
    (env.object as { name?: string })?.name === "process" &&
    (env.property as { name?: string })?.name === "env"
  );
}

/** Evaluate `process.env.NODE_ENV (===|!==|==|!=) "literal"` (either operand order)
 *  against a known `nodeEnv`. Returns the boolean, or undefined if not this shape. */
function evalNodeEnvTest(test: Node | undefined, nodeEnv: string): boolean | undefined {
  if (!test || test.type !== "BinaryExpression") return undefined;
  const op = (test as { operator?: string }).operator;
  if (op !== "===" && op !== "!==" && op !== "==" && op !== "!=") return undefined;
  const l = test.left as Node;
  const r = test.right as Node;
  let lit: unknown;
  if (isNodeEnv(l) && r.type === "Literal") lit = (r as { value?: unknown }).value;
  else if (isNodeEnv(r) && l.type === "Literal") lit = (l as { value?: unknown }).value;
  else return undefined;
  const eq = nodeEnv === lit;
  return op[0] === "!" ? !eq : eq;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const k of Object.keys(node as object)) {
    const v = (node as Record<string, unknown>)[k];
    if (Array.isArray(v)) for (const c of v) walk(c, visit);
    else if (v && typeof (v as Node).type === "string") walk(v, visit);
  }
}

/** The live branch's source text; a block's inner statements (braces stripped, so
 *  no new scope is introduced), else the branch verbatim. */
function branchText(source: string, branch: Node | undefined): string {
  if (!branch) return "";
  if (branch.type === "BlockStatement") {
    const body = branch.body as Node[];
    return body.length ? source.slice(body[0].start, body[body.length - 1].end) : "";
  }
  return source.slice(branch.start, branch.end);
}

/**
 * Fold `process.env.NODE_ENV`-gated `if`/ternary against a known `nodeEnv`, splicing
 * in only the live branch. React's package entry (`module.exports = require(NODE_ENV
 * ? prod : dev)`) would otherwise static-import BOTH builds → two react instances →
 * `ReactSharedInternals` undefined at render. Only outermost matches are spliced (a
 * kept branch's inner code is left as-is); a parse failure returns the source
 * unchanged.
 */
function foldNodeEnv(source: string, nodeEnv: string): string {
  if (!source.includes("process.env.NODE_ENV")) return source;
  let ast: unknown;
  try {
    ast = acornParse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return source;
  }
  const edits: { s: number; e: number; text: string }[] = [];
  walk(ast, (n) => {
    if (n.type === "IfStatement") {
      const v = evalNodeEnvTest(n.test as Node, nodeEnv);
      if (v === true)
        edits.push({ s: n.start, e: n.end, text: branchText(source, n.consequent as Node) });
      else if (v === false)
        edits.push({ s: n.start, e: n.end, text: branchText(source, n.alternate as Node) });
    } else if (n.type === "ConditionalExpression") {
      const v = evalNodeEnvTest(n.test as Node, nodeEnv);
      if (v !== undefined)
        edits.push({
          s: n.start,
          e: n.end,
          text: branchText(source, (v ? n.consequent : n.alternate) as Node),
        });
    }
  });
  // Keep only outermost edits (a kept branch's nested conditional stays intact).
  const outer = edits.filter((e) => !edits.some((o) => o !== e && o.s <= e.s && e.e <= o.e));
  outer.sort((a, b) => b.s - a.s); // splice from the end so offsets stay valid
  let out = source;
  for (const e of outer) out = out.slice(0, e.s) + e.text + out.slice(e.e);
  return out;
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
export function newCjsTransform(production = false): Transform {
  const nodeEnv = production ? "production" : "development";
  return {
    async transform(
      file: SourceFile,
      rewrite: (specifier: string) => string,
    ): Promise<TransformResult> {
      lexerReady ??= init();
      await lexerReady;

      // Fold `process.env.NODE_ENV` conditionals to the live branch BEFORE collecting
      // requires — so a dual-build entry (React) imports one instance, not both.
      const source = foldNodeEnv(file.source, nodeEnv);
      const specs = findRequires(source);
      const importLines: string[] = [];
      const mapEntries: string[] = [];
      specs.forEach((spec, i) => {
        importLines.push(`import * as __d${i} from ${JSON.stringify(rewrite(spec))};`);
        mapEntries.push(`  ${JSON.stringify(spec)}: __d${i},`);
      });

      let names: string[] = [];
      let reexports: string[] = [];
      try {
        const parsed = parse(source);
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
      const code = [
        ...importLines,
        `const __ns = {\n${mapEntries.join("\n")}\n};`,
        `const module = { exports: {} };`,
        `const require = (s) => {`,
        `  const m = __ns[s];`,
        `  if (!m) throw new Error("Cannot require (computed/unresolved): " + s);`,
        `  return m.default !== undefined ? m.default : m;`,
        `};`,
        `(function (module, exports, require, __filename, __dirname) {`,
        source,
        `}).call(module.exports, module, module.exports, require, ${JSON.stringify(file.path)}, ${JSON.stringify(dir)});`,
        `export default module.exports;`,
        namedExports,
        reexportLines,
      ]
        .filter(Boolean)
        .join("\n");
      return { code };
    },
  };
}
