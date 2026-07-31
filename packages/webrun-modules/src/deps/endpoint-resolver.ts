import type { EndpointBinding, EndpointCtx, EndpointResolver } from "../types.js";

/** The server's default linker: host for provided names (and the "" globals
 *  key), same-origin `local` for everything else. Never emits `cdn`/`inline`
 *  (those come only from a caller-supplied custom resolver). */
export function newDefaultEndpointResolver(opts: {
  providedNames: (name: string) => boolean;
  localUrl: (specifier: string, ctx: EndpointCtx) => Promise<string>;
}): EndpointResolver {
  return {
    async resolve(specifier, ctx): Promise<EndpointBinding> {
      if (opts.providedNames(specifier)) return { kind: "host", name: specifier };
      return { kind: "local", url: await opts.localUrl(specifier, ctx) };
    },
  };
}
