import { parse as acornParse } from "acorn";
import attachGlobals from "acorn-globals";
import type { ModuleDescriptor, ModuleImport, SourceFormat } from "../types.js";
import { toJs } from "./to-js.js";

/** The parser seam. acorn baseline (pure-JS, isomorphic); oxc-wasm may replace
 *  this behind the same signature once the spike validates it. Exported so the
 *  ESM transform reuses the SAME parser config for its specifier-rewrite spans
 *  (replacing es-module-lexer — see Task 7). acorn sets `start`/`end` on every
 *  node natively, which the splice needs. */
export function parseEsmModule(js: string) {
  return acornParse(js, { ecmaVersion: "latest", sourceType: "module" }) as unknown as {
    body: any[];
  };
}

function emptyImport(): ModuleImport {
  return { names: [], hasNamespace: false, hasDefault: false };
}

/**
 * Analyze one module into its import/export descriptor. TS/JSX is stripped via
 * `toJs` first (acorn can't parse types/JSX, and stripping surfaces the
 * sucrase-injected `react/jsx-runtime` import). Free globals are detected with
 * `acorn-globals` (scope-aware) and recorded under the reserved `""` key.
 */
export async function analyze(source: string, format: SourceFormat): Promise<ModuleDescriptor> {
  const js = toJs(source, format);
  const ast = parseEsmModule(js);
  const imports: Record<string, ModuleImport> = {};
  const exports = new Set<string>();

  const importFor = (spec: string) => {
    imports[spec] ??= emptyImport();
    return imports[spec];
  };

  for (const node of ast.body) {
    switch (node.type) {
      case "ImportDeclaration": {
        const imp = importFor(node.source.value);
        for (const s of node.specifiers) {
          if (s.type === "ImportDefaultSpecifier") imp.hasDefault = true;
          else if (s.type === "ImportNamespaceSpecifier") imp.hasNamespace = true;
          else imp.names.push(s.imported.name ?? s.imported.value); // ImportSpecifier
        }
        break;
      }
      case "ExportNamedDeclaration": {
        if (node.source) importFor(node.source.value); // re-export → also an import edge
        for (const s of node.specifiers ?? []) exports.add(s.exported.name ?? s.exported.value);
        if (node.declaration) collectDeclNames(node.declaration, exports);
        break;
      }
      case "ExportDefaultDeclaration":
        exports.add("default");
        break;
      case "ExportAllDeclaration": {
        importFor(node.source.value);
        if (node.exported) exports.add(node.exported.name ?? node.exported.value);
        break;
      }
    }
  }

  // Free (unbound) identifiers — scope-aware, so locally-declared names are
  // excluded. MUST pass sourceType:"module" or acorn-globals throws on the
  // import/export statements the stripped `js` still contains.
  const free = (
    attachGlobals as unknown as (
      src: string,
      opts: { ecmaVersion: string; sourceType: string },
    ) => { name: string }[]
  )(js, { ecmaVersion: "latest", sourceType: "module" });
  if (free.length)
    imports[""] = {
      names: [...new Set(free.map((g) => g.name))],
      hasNamespace: false,
      hasDefault: false,
    };

  return { imports, exports: [...exports] };
}

/** Pull exported binding names out of an `export const/let/var/function/class` decl. */
function collectDeclNames(decl: any, out: Set<string>): void {
  if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations) if (d.id.type === "Identifier") out.add(d.id.name);
  } else if (decl.id?.name) {
    out.add(decl.id.name); // FunctionDeclaration / ClassDeclaration
  }
}
