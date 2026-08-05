import { writeText } from "@statewalker/webrun-files";
import { proxyId } from "../deps/proxy.js";
import { relativeUrl } from "../server/specifiers.js";
import { analyze } from "../transform/analyze.js";
import { coarseBucket, detectInputType, type PreprocessContext, urlPath } from "./context.js";
import {
  cssSpecifiers,
  ensureGlobalsProxy,
  loadRaw,
  rawBytes,
  resolveCssSpec,
  resolveSpec,
} from "./resolve.js";

/** The per-file preprocess core: transform one module id and cache the emitted
 *  artifact, returning the emitted code. Loads the raw source, classifies it
 *  (`detectInputType`), then dispatches through `ctx.transforms` — the exact
 *  registered type when present, else its `coarseBucket` fallback. The default
 *  registry routes `module` → `jsTransform`, `css` → `cssTransform`, matching the
 *  pre-registry behaviour exactly. Writes to `ctx.policy.emittedPath(id)`. */
export async function preprocessModule(
  id: string,
  ctx: PreprocessContext,
): Promise<{ code: string; emittedId: string }> {
  const { source } = await loadRaw(id, ctx);
  const registry = ctx.transforms;
  if (!registry) throw new Error("preprocessModule: ctx.transforms is not set");
  const ty = detectInputType(id, source);
  const t = registry.has(ty) ? registry.get(ty) : registry.get(coarseBucket(ty));
  return t.run(id, source, ctx);
}

/** CSS branch: two Lightning CSS passes — pass 1 (via `cssSpecifiers`) captures
 *  every @import/url() specifier; the specifiers are resolved asynchronously (the
 *  seam's `rewrite` stays sync); pass 2 substitutes the resolved urls. Emits the
 *  code + its exports sidecar. */
export async function cssTransform(
  id: string,
  source: string,
  ctx: PreprocessContext,
): Promise<{ code: string; emittedId: string }> {
  const emittedId = ctx.policy.emittedPath(id);
  const { path } = await loadRaw(id, ctx);
  const cssModules = /\.module\.css$/.test(id);
  const rewrites = new Map<string, string>();
  for (const spec of await cssSpecifiers(path, source, ctx)) {
    const { url } = await resolveCssSpec(spec, id, ctx);
    rewrites.set(spec, url);
  }
  const out = await ctx.css.transform({ path, source, cssModules }, (s) => rewrites.get(s) ?? s);
  await writeText(ctx.cache, emittedId, out.code);
  await writeText(ctx.cache, `${emittedId}.exports.json`, JSON.stringify(out.exports));
  return { code: out.code, emittedId };
}

/** JS branch: analyze → resolve each import to its served URL, prepend a globals
 *  prelude for allowlisted free vars, run the ESM transform, emit. */
export async function jsTransform(
  id: string,
  source: string,
  ctx: PreprocessContext,
): Promise<{ code: string; emittedId: string }> {
  const emittedId = ctx.policy.emittedPath(id);
  const { path, format } = await loadRaw(id, ctx);
  const { imports } = await analyze(source, format);
  const map = new Map<string, string>();
  for (const spec of Object.keys(imports)) {
    if (spec === "") continue;
    const { url } = await resolveSpec(spec, id, imports[spec], ctx);
    map.set(spec, url);
  }
  // Globals: prepend an import from a co-located globals proxy for allowlisted
  // free vars (declared/imported names never appear in the `""` free-global set).
  const usedGlobals = (imports[""]?.names ?? []).filter((n) => Object.hasOwn(ctx.globals, n));
  let prelude = "";
  if (usedGlobals.length) {
    const gid = proxyId(id, "");
    await ensureGlobalsProxy(gid, usedGlobals, ctx);
    prelude = `import { ${usedGlobals.join(", ")} } from ${JSON.stringify(
      relativeUrl(urlPath(id, ctx), urlPath(gid, ctx)),
    )};\n`;
  }
  const { code } = await ctx.transform.transform({ path, source, format }, (s) => map.get(s) ?? s);
  await writeText(ctx.cache, emittedId, prelude + code);
  return { code: prelude + code, emittedId };
}

/** Emit a JSON file as an ESM module body (`export default …`) — how a JS
 *  `import` of a `.json` is satisfied without JSON-import attributes. Returns the
 *  code string (or `undefined` when the file has no bytes) so both the server
 *  fetch path and a build reuse one body; the server wraps it in a `Response`. */
export async function serveJsonModule(
  id: string,
  ctx: PreprocessContext,
): Promise<string | undefined> {
  const bytes = await rawBytes(id, ctx);
  if (!bytes) return undefined;
  const json = new TextDecoder().decode(bytes);
  return `export default ${json};`;
}

/** JS module that injects the processed CSS as a <style> (guarded for non-DOM /
 *  Node) and default-exports the CSS Modules class map (when `cssModules`) or the
 *  CSS text otherwise. Returns the code string; the server wraps it in a
 *  `Response`. */
export function cssModuleWrapper(
  css: string,
  exports: Record<string, string>,
  cssModules: boolean,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `if (typeof document !== "undefined") {`,
    `  const el = document.createElement("style");`,
    `  el.textContent = css;`,
    `  document.head.appendChild(el);`,
    `}`,
    `export default ${cssModules ? JSON.stringify(exports) : "css"};`,
  ].join("\n");
}
