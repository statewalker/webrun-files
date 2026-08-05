/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readText, writeText } from "@statewalker/webrun-files";
import type { PreprocessContext, RegisteredTransform } from "@statewalker/webrun-modules";
import { __unstable__loadDesignSystem, compile } from "tailwindcss";

const req = createRequire(import.meta.url);

/** The pinned Tailwind version — the transform's sole input-independent cache
 *  dimension (generation is version-keyed; see `tailwindCacheKey`). */
export const TAILWIND_VERSION = "4.3.3";

/** True when the source already pulls in Tailwind's full design system via the
 *  v4 `@import "tailwindcss"`. A source that uses only the legacy `@tailwind`
 *  directives yields a PARTIAL utility set, so we prepend the import (below). */
const HAS_TW_IMPORT = /^\s*@import\s+["']tailwindcss["']/m;

/** `~/x` id → its project-space path (`/x`); a plain path is returned as-is. */
function projectPath(id: string): string {
  return id.startsWith("~/") ? `/${id.slice(2)}` : id;
}

/** The tailwindcss package root (where `index.css`/`theme.css`/… live).
 *  require.resolve → …/tailwindcss/dist/lib.(js|mjs); the root is two dirs up. */
function tailwindDir(): string {
  return dirname(dirname(req.resolve("tailwindcss")));
}

/**
 * A ctx-bound `loadStylesheet` resolver. It reads from two roots, chosen by where
 * the resolved path lands:
 *  - **tailwindcss's own bundled CSS** (`@import "tailwindcss"` + its sub-imports,
 *    and any path under the package dir) via `node:fs` — a build-time
 *    dependency-asset read, NOT project I/O (the ONLY `node:fs` use here).
 *  - **project-relative `@import`s** (e.g. `@import "./tokens.css"` in the entry)
 *    via `ctx.files`, so a customized entry's siblings resolve.
 */
function makeStylesheetLoader(ctx: PreprocessContext) {
  const twDir = tailwindDir();
  return async function loadStylesheet(
    id: string,
    base: string,
  ): Promise<{ path: string; base: string; content: string }> {
    let path: string;
    if (id === "tailwindcss") {
      path = resolve(twDir, "index.css");
    } else if (id.startsWith("tailwindcss/")) {
      const rel = id.slice("tailwindcss/".length);
      path = resolve(twDir, rel + (rel.endsWith(".css") ? "" : ".css"));
    } else {
      path = resolve(base, id);
    }
    if (path.startsWith(twDir)) {
      return { base: dirname(path), content: readFileSync(path, "utf8"), path };
    }
    if (!ctx.files)
      throw new Error("webrun-tailwind: ctx.files required to resolve project @import");
    return { base: dirname(path), content: await readText(ctx.files, path), path };
  };
}

/**
 * Generate the all-classes Tailwind (v4) stylesheet, HONORING the project entry's
 * own `@theme`/`@utility`/`@layer` customizations + sibling `@import`s: the entry
 * source itself drives the design system (so custom tokens exist and theme-derived
 * utilities use the project's values), then every known utility name is compiled
 * against that system. Still generic (all utilities, no JSX/HTML/DOM scan) — the
 * running markup selects what it uses. The v4 `@import "tailwindcss"` is prepended
 * when absent so a legacy `@tailwind`-directive source still loads the full system.
 */
export async function generateTailwindCss(
  source: string,
  ctx: PreprocessContext,
  entryId: string,
): Promise<string> {
  const loadStylesheet = makeStylesheetLoader(ctx);
  const entry = HAS_TW_IMPORT.test(source) ? source : `@import "tailwindcss";\n${source}`;
  const base = dirname(projectPath(entryId));
  const ds = await __unstable__loadDesignSystem(entry, { base, loadStylesheet });
  const candidates = ds.getClassList().map(([name]) => name);
  const compiler = await compile(entry, { base, loadStylesheet });
  return compiler.build(candidates);
}

/**
 * The Tailwind-specific cache dimension folded into the build's `skipTransform`
 * hash. The entry SOURCE — which now drives generation (`@theme`/customizations) —
 * is hashed separately by that closure (`… + "\n" + source`), so this contributes
 * only the pinned Tailwind VERSION: a Tailwind upgrade re-generates even when the
 * entry bytes are unchanged. Test seam: `TW_CACHE_VER` overrides the version.
 */
export function tailwindCacheKey(_source: string): string {
  return process.env.TW_CACHE_VER ?? TAILWIND_VERSION;
}

/**
 * The build-only Tailwind transform: consumes a `tailwind-css` input and emits a
 * processed `.css` artifact (the generic all-classes stylesheet run through the
 * shared CSS transform for Lightning parity). Registered on the build's context
 * only — the request-time server has no such entry, so `tailwind-css` there falls
 * back to the plain `css` transform, unchanged.
 */
export function newTailwindTransform(): RegisteredTransform {
  return {
    inType: "tailwind-css",
    outType: "css",
    async run(id: string, source: string, ctx: PreprocessContext) {
      const emittedId = ctx.policy.emittedPath(id);
      const genericCss = await generateTailwindCss(source, ctx, id);
      // Lightning parity pass with an identity specifier rewrite (the generic
      // stylesheet has no project @import/url specifiers to resolve).
      const out = await ctx.css.transform(
        { path: id, source: genericCss, cssModules: false },
        (s) => s,
      );
      await writeText(ctx.cache, emittedId, out.code);
      await writeText(ctx.cache, `${emittedId}.exports.json`, JSON.stringify(out.exports ?? {}));
      return { code: out.code, emittedId };
    },
  };
}
