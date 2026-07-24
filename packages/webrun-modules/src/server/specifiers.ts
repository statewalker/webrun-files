/** Split a bare specifier into package name + optional subpath (scope-aware). */
export function parseSpecifier(spec: string): { pkg: string; subpath?: string } {
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    const pkg = parts.slice(0, 2).join("/");
    const subpath = parts.slice(2).join("/");
    return subpath ? { pkg, subpath } : { pkg };
  }
  const [pkg, ...rest] = parts;
  const subpath = rest.join("/");
  return subpath ? { pkg, subpath } : { pkg };
}

/**
 * Relative URL from one canonical module id to another (both are slash paths with
 * no leading slash, filename last). Keeps served imports mount-prefix-portable.
 */
export function relativeUrl(fromId: string, toId: string): string {
  const from = fromId.split("/").slice(0, -1); // importer directory parts
  const to = toId.split("/");
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const ups = from.length - i;
  const rel = [...Array(ups).fill(".."), ...to.slice(i)].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}
