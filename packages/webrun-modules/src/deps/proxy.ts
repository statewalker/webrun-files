import { relativeUrl } from "../server/specifiers.js";
import type { EndpointBinding, ModuleImport } from "../types.js";

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Slug a specifier into a filename-safe segment ("react/jsx-runtime" → "react__jsx-runtime"). */
function slug(specifier: string): string {
  return specifier === "" ? "globals" : specifier.replace(/\//g, "__");
}

/** Co-located per-module proxy id for one external specifier root. */
export function proxyId(importerId: string, specifier: string): string {
  const slash = importerId.lastIndexOf("/");
  const dir = slash >= 0 ? importerId.slice(0, slash) : "";
  const base = slash >= 0 ? importerId.slice(slash + 1) : importerId;
  const prefix = dir ? `${dir}/` : "";
  return `${prefix}~deps/${base}/deps.${slug(specifier)}.js`;
}

/**
 * The proxy module's ESM source. `local`/`cdn` re-export from a real ESM endpoint
 * (relative for `local`, absolute for `cdn`); `host` reads the shared runtime
 * registry so every proxy of a name yields the SAME instance; `inline` is the
 * bundled body verbatim.
 */
export function proxyBody(args: {
  proxyId: string;
  binding: EndpointBinding;
  imp: ModuleImport;
  registryKey: string;
}): string {
  const { binding, imp } = args;
  const named = imp.names.filter((n) => IDENT_RE.test(n) && n !== "default");

  if (binding.kind === "inline") return binding.code;

  if (binding.kind === "host") {
    const lines = [
      `const __m = globalThis.${args.registryKey}.get(${JSON.stringify(binding.name)});`,
    ];
    if (imp.hasDefault || (!named.length && !imp.hasNamespace)) lines.push("export default __m;");
    for (const n of [...new Set(named)]) lines.push(`export const ${n} = __m.${n};`);
    // Namespace (`* as X`) of a host module can't be enumerated — default-as-instance
    // covers property access; a true enumerated namespace is unsupported (documented).
    return lines.join("\n");
  }

  // local | cdn — a real ESM endpoint we can re-export from.
  const endpoint =
    binding.kind === "local"
      ? relativeUrl(args.proxyId, binding.url) // url is the endpoint's canonical id for local
      : binding.url; // absolute CDN url
  const q = JSON.stringify(endpoint);
  const lines: string[] = [];
  if (named.length) lines.push(`export { ${[...new Set(named)].join(", ")} } from ${q};`);
  if (imp.hasDefault) lines.push(`export { default } from ${q};`);
  if (imp.hasNamespace || (!named.length && !imp.hasDefault)) lines.push(`export * from ${q};`);
  return lines.join("\n");
}
