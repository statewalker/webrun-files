import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { writeText } from "@statewalker/webrun-files";
import type { PreprocessContext, RegisteredTransform } from "@statewalker/webrun-modules";
import { __unstable__loadDesignSystem, compile } from "tailwindcss";

const req = createRequire(import.meta.url);

/** The pinned Tailwind version — the transform's sole input-independent cache
 *  dimension (generation is generic; see `tailwindCacheKey`). */
export const TAILWIND_VERSION = "4.3.3";

/** The canonical entry stylesheet fed to Tailwind's design system + compiler.
 *  Generation is GENERIC — every utility, independent of the project source — so
 *  the entry is always `@import "tailwindcss";`, never the project's own bytes. */
const ENTRY_CSS = '@import "tailwindcss";';

/**
 * The one place `node:fs` is used: reads the **tailwindcss dependency's own
 * bundled CSS assets** (`index.css`, `theme.css`, `preflight.css`,
 * `utilities.css`) so the design system + compiler can resolve `@import
 * "tailwindcss"` and its sub-imports. This is a build-time dependency-asset read,
 * NOT project/cache I/O — those always go through `ctx.files`/`ctx.cache`. Kept
 * isolated in this resolver by design.
 */
function tailwindDir(): string {
  // require.resolve("tailwindcss") → …/tailwindcss/dist/lib.(js|mjs); the package
  // root (where index.css etc. live) is two dirs up.
  return dirname(dirname(req.resolve("tailwindcss")));
}

async function loadTailwindStylesheet(
  id: string,
  base: string,
): Promise<{ path: string; base: string; content: string }> {
  const dir = tailwindDir();
  let path: string;
  if (id === "tailwindcss") {
    path = resolve(dir, "index.css");
  } else if (id.startsWith("tailwindcss/")) {
    const rel = id.slice("tailwindcss/".length);
    path = resolve(dir, rel + (rel.endsWith(".css") ? "" : ".css"));
  } else {
    path = resolve(base, id);
  }
  return { base: dirname(path), content: readFileSync(path, "utf8"), path };
}

/**
 * Generate the generic all-classes Tailwind (v4) stylesheet: load the design
 * system to enumerate every utility class name, then compile the canonical entry
 * against that full candidate set. The project `source` is intentionally ignored
 * — the build emits ALL utilities and the running markup selects what it uses
 * (build-only, no content scanning).
 */
export async function generateTailwindCss(_source: string): Promise<string> {
  const base = tailwindDir();
  const ds = await __unstable__loadDesignSystem(ENTRY_CSS, {
    base,
    loadStylesheet: loadTailwindStylesheet,
  });
  const candidates = ds.getClassList().map(([name]) => name);
  const compiler = await compile(ENTRY_CSS, { base, loadStylesheet: loadTailwindStylesheet });
  return compiler.build(candidates);
}

/**
 * Inputs-only cache key for the Tailwind transform. Because generation is generic
 * (independent of the project source — the build hashes the source bytes
 * separately), the key is just the pinned Tailwind version. Test seam: the
 * `TW_CACHE_VER` env var overrides the version so a test can invalidate the cache
 * without touching the entry bytes.
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
      const genericCss = await generateTailwindCss(source);
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
