import init, { transform as lcTransform } from "lightningcss-wasm";
import type { CssFile, CssTransform, CssTransformResult } from "../../types.js";

let ready: Promise<unknown> | undefined;

// Conservative modern-browser floor (~2023, roughly a "last 2 years" browserslist
// query) so a declaration like `.a { user-select: none }` actually gets
// vendor-prefixed, without resolving project browserslist config (out of scope —
// see Global Constraints). Lightning CSS encodes a target version as
// `(major << 16) | (minor << 8) | patch`. A future `CssTransform` revision could
// thread this through as an option; not needed for this plan's scope.
const DEFAULT_TARGETS = {
  chrome: 111 << 16,
  firefox: 111 << 16,
  safari: (16 << 16) | (4 << 8),
} as const;

/** Default CSS transform: Lightning CSS (WASM). Nesting, autoprefix (targets),
 *  CSS Modules, and `analyzeDependencies` (which replaces every @import/url with
 *  a placeholder we substitute with the rewritten same-origin URL). */
export function newLightningCssTransform(): CssTransform {
  return {
    async transform(
      file: CssFile,
      rewrite: (specifier: string) => string,
    ): Promise<CssTransformResult> {
      ready ??= init();
      await ready;
      const res = lcTransform({
        filename: file.path,
        code: new TextEncoder().encode(file.source),
        minify: false,
        cssModules: file.cssModules,
        targets: DEFAULT_TARGETS,
        // Bare `true` makes Lightning CSS DROP `@import` rules from the output
        // entirely (no placeholder to substitute) — verified empirically. Only
        // `{ preserveImports: true }` keeps a substitutable placeholder.
        analyzeDependencies: { preserveImports: true },
      });
      let code = new TextDecoder().decode(res.code);
      // `Dependency` is a 4-variant union (`ImportDependency | UrlDependency |
      // FileDependency | GlobDependency`) in the installed lightningcss-wasm;
      // only the first two carry `url`/`placeholder` and are the ones
      // `analyzeDependencies` ever produces (File/Glob come from the `visitor`
      // API, unused here) — narrow on `type` to satisfy both TS and runtime.
      for (const dep of res.dependencies ?? []) {
        if (dep.type === "import" || dep.type === "url") {
          code = code.split(dep.placeholder).join(rewrite(dep.url));
        }
      }
      const exports: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.exports ?? {})) exports[k] = v.name;
      return { code, exports };
    },
  };
}
