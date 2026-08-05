import { readText, tryReadText, writeText } from "@statewalker/webrun-files";
import {
  cssModuleWrapper,
  type PreprocessContext,
  rawBytes,
  serveJsonModule,
  urlPath,
} from "@statewalker/webrun-modules";

/** Code/json/css module extensions the build transforms into `.js` forms. Anything
 *  else reached in a walk (e.g. a `url("./logo.png")` target) is an opaque ASSET:
 *  copied verbatim to its (unchanged) ext-map path, never transformed. */
const MODULE_EXT = /\.(?:m|c)?[jt]sx?$|\.json$|\.css$/i;

/** An id is an asset when its extension is not a code/json/css module extension. */
export function isAsset(id: string): boolean {
  return !MODULE_EXT.test(id);
}

/**
 * Emit the build's static module forms for the JSON/CSS ids in a walk closure.
 *
 * The shared `walkFrom` core emits JS modules + `~deps` proxies + npm endpoints,
 * and — for CSS — the raw processed stylesheet + its `.exports.json` sidecar; JSON
 * project sources it leaves un-emitted (the server serves them on demand). The
 * static build has no request-time `?module` fork, so it commits to one file form
 * per id, written where the ext-map policy points the importer's rewritten
 * specifier (`emittedPath`, which maps `.json`/`.css` → `.js`):
 *
 *  - **JSON → `serveJsonModule`** — an `export default …` ESM body.
 *  - **CSS imported from JS → `cssModuleWrapper`** — a `.js` <style> injector that
 *    default-exports the class map (CSS Modules) or the CSS text. The raw stylesheet
 *    `walkFrom` already wrote at `emittedPath(id)` is read back and wrapped in place.
 *
 * Beyond the JS-imported stylesheet, an `@import`-chained `.css` is also emitted as
 * a real `.css` file at its `urlPath` (so the injected `@import "./x.css"` resolves),
 * and a `url("./logo.png")` asset is copied verbatim to its ext-map path.
 *
 * Idempotent: re-running over the same ids rewrites identical bytes. The caller
 * (Preprocess cell) passes only freshly-emitted CSS ids so a gate-skipped node's
 * already-wrapped `.js` is never double-wrapped.
 */
export async function emitBuildForms(ids: string[], ctx: PreprocessContext): Promise<void> {
  for (const id of ids) {
    const emitted = ctx.policy.emittedPath(id);
    if (id.endsWith(".json")) {
      const code = await serveJsonModule(id, ctx);
      if (code !== undefined) await writeText(ctx.cache, emitted, code);
    } else if (id.endsWith(".css")) {
      // `walkFrom`/`preprocessModule` wrote the processed CSS to `emitted` and its
      // class map to `${emitted}.exports.json`; wrap them into the injector in place.
      const css = await readText(ctx.cache, emitted);
      // F2: also emit the processed stylesheet as a real `.css` file at its
      // urlPath (no ext-map) so an `@import "./x.css"` in another stylesheet — whose
      // specifier keeps `.css` — resolves to a live file instead of 404. The two
      // paths differ only by extension (`/~/x.css` vs `/~/x.js`), so no collision.
      await writeText(ctx.cache, `/${urlPath(id, ctx)}`, css);
      const exportsJson = await tryReadText(ctx.cache, `${emitted}.exports.json`);
      const exports = exportsJson ? (JSON.parse(exportsJson) as Record<string, string>) : {};
      const cssModules = /\.module\.css$/.test(id);
      await writeText(ctx.cache, emitted, cssModuleWrapper(css, exports, cssModules));
    } else if (isAsset(id)) {
      // F3: a `url("./logo.png")` target — copy the raw bytes verbatim to its
      // ext-map path (a non-code ext is left unchanged, so `emitted` = `/~/logo.png`).
      const bytes = await rawBytes(id, ctx);
      if (bytes) await ctx.cache.write(emitted, [bytes]);
    }
  }
}
