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
      // NOTE: this `host` branch is currently unreached — the server's `resolveSpec`
      // intercepts provided names before calling the resolver. If ever reached, it
      // must bind to the REGISTERED key (exact spec if registered, else its package
      // root), matching `resolveSpec`, or a subpath like `react/jsx-runtime` would
      // bind to an unregistered key and resolve to `undefined` at load (the I2 bug).
      if (opts.providedNames(specifier)) return { kind: "host", name: specifier };
      return { kind: "local", url: await opts.localUrl(specifier, ctx) };
    },
  };
}
