import {
  type PreprocessContext,
  relativeUrl,
  type UrlPolicy,
  urlPath,
} from "@statewalker/webrun-modules";

/** Ext-map: JS-family (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`), `.json`, and `.css`
 *  all collapse to `.js` — every emitted module is a static `.js`, so an import's
 *  final URL is a pure function of the specifier name (content-independent). A JSON
 *  import becomes a `serveJsonModule` `.js`; a CSS import from JS becomes a
 *  `cssModuleWrapper` injector `.js` (emit forms wired in the build's Preprocess
 *  cell). Anything else is left as-is. */
function extMap(path: string): string {
  return path
    .replace(/\.(?:m|c)?[jt]sx?$/i, ".js")
    .replace(/\.json$/i, ".js")
    .replace(/\.css$/i, ".js");
}

/**
 * The batch build's URL-naming policy, built from `ctx` (closes over
 * `ctx.depsPath`). Mirror image of `makeKeepExtPolicy`, differing ONLY in the ext
 * decision and the absence of `?module` marking: JS-family/json → `.js`, css → `.css`,
 * no `?module`. Everything else (the `urlPath`/depsPrefix id-space, proxy naming,
 * resolution) is core-owned and shared with the server.
 */
export function makeExtMapPolicy(ctx: PreprocessContext): UrlPolicy {
  return {
    servedUrl(targetId, importerId) {
      return relativeUrl(urlPath(importerId, ctx), extMap(urlPath(targetId, ctx)));
    },
    emittedPath(id) {
      return `/${extMap(urlPath(id, ctx))}`;
    },
  };
}
