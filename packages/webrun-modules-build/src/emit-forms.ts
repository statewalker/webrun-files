import { readText, tryReadText, writeText } from "@statewalker/webrun-files";
import {
  cssModuleWrapper,
  type PreprocessContext,
  serveJsonModule,
} from "@statewalker/webrun-modules";

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
 * Idempotent: re-running over the same ids rewrites identical bytes.
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
      const exportsJson = await tryReadText(ctx.cache, `${emitted}.exports.json`);
      const exports = exportsJson ? (JSON.parse(exportsJson) as Record<string, string>) : {};
      const cssModules = /\.module\.css$/.test(id);
      await writeText(ctx.cache, emitted, cssModuleWrapper(css, exports, cssModules));
    }
  }
}
