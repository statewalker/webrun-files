import {
  type PreprocessContext,
  relativeUrl,
  type UrlPolicy,
  urlPath,
} from "@statewalker/webrun-modules";

/** Ext-map: JS-family (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`) and `.json` collapse
 *  to `.js`; `.css` is kept; anything else is left as-is. This is the batch driver's
 *  extension decision — every emitted module is a static `.js`, so an import's final
 *  URL is a pure function of the specifier name (content-independent). */
function extMap(path: string): string {
  return path.replace(/\.(?:m|c)?[jt]sx?$/i, ".js").replace(/\.json$/i, ".js");
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
