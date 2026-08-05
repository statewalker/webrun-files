import { writeText } from "@statewalker/webrun-files";
import { proxyId } from "../deps/proxy.js";
import { analyze } from "../transform/analyze.js";
import { detectInputType, isCssFile, isModuleFile, type PreprocessContext } from "./context.js";
import { preprocessModule } from "./module.js";
import { cssSpecifiers, ensureRawByKey, loadRaw, resolveCssSpec, resolveSpec } from "./resolve.js";

/** BFS closure walk from an already-resolved entry id: analyze → resolve → emit
 *  each reachable module id (via `preprocessModule`), writing the `~deps` proxy
 *  bodies + resolved npm endpoints as resolve side-effects; skips re-analyzing
 *  pre-generated `~deps` proxy ids exactly as the server's `walkGraph` did.
 *  Single-sourced traversal for the request-time server and the batch build.
 *  Persists the lockfile at the end and returns every reachable id. */
export async function walkFrom(entryId: string, ctx: PreprocessContext): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [entryId];
  while (queue.length) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    // `~deps` proxies are pre-generated at their emitted path by their importer's
    // resolveSpec/preprocessModule — served from cache, never re-analyzed.
    if (id.includes("/~deps/") && (await ctx.cache.exists(ctx.policy.emittedPath(id)))) continue;
    if (isCssFile(id)) {
      const { path, source } = await loadRaw(id, ctx);
      // Opt-in gate: skip re-transform when the artifact is already current, but
      // still traverse children below so the closure is walked.
      if (!(ctx.skipTransform && (await ctx.skipTransform(id, source)))) {
        await preprocessModule(id, ctx); // ensures the file + its exports are cached
      }
      // BUILD-ONLY: when a Tailwind transform is registered and this file is a
      // `tailwind-css` input, the transform already generated the full stylesheet,
      // so the bare `@import "tailwindcss"` (or `tailwindcss/…`) is NOT a real npm
      // child — suppress it so the walk never tries to npm-resolve it. The server
      // (no such registered entry) leaves `twActive` false, so it is unaffected.
      const twActive =
        !!ctx.transforms?.has("tailwind-css") && detectInputType(id, source) === "tailwind-css";
      // Reuse cssSpecifiers — the SAME helper preprocessModule uses — then
      // re-derive child ids via CSS's own direct resolver (never `resolveSpec`:
      // that one proxies bare externals through `~deps`, which CSS must not do).
      for (const spec of await cssSpecifiers(path, source, ctx)) {
        if (twActive && /^tailwindcss($|\/)/.test(spec)) continue;
        const { id: childId } = await resolveCssSpec(spec, id, ctx);
        if (childId && !seen.has(childId)) queue.push(childId);
      }
      continue;
    }
    if (!isModuleFile(id)) {
      // non-JS resource (json/…): ensure it's cached, don't scan/transform.
      const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\//);
      if (m) await ensureRawByKey(m[1], ctx);
      continue;
    }
    const { source, format } = await loadRaw(id, ctx);
    const { imports } = await analyze(source, format);
    for (const spec of Object.keys(imports)) {
      if (spec === "") {
        // Only allowlisted free globals get a proxy (matches preprocessModule);
        // real globals like `console`/`Math` are left as native references.
        if (imports[""].names.some((n) => Object.hasOwn(ctx.globals, n))) {
          queue.push(proxyId(id, ""));
        }
        continue;
      }
      const { id: childId, endpointId } = await resolveSpec(spec, id, imports[spec], ctx);
      if (childId && !seen.has(childId)) queue.push(childId); // the proxy
      if (endpointId && !seen.has(endpointId)) queue.push(endpointId); // the real endpoint
    }
    // Opt-in gate: children were queued above, so skipping the transform still
    // leaves the closure fully walked.
    if (!(ctx.skipTransform && (await ctx.skipTransform(id, source)))) {
      await preprocessModule(id, ctx);
    }
  }
  await writeText(ctx.cache, "/lock.json", JSON.stringify(ctx.lock));
  return [...seen];
}
