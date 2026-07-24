import { legacy, resolve as resolveExports } from "resolve.exports";
import type { ModuleTarget, PackageManifest } from "../types.js";

/** Strip a leading `./` or `/` so the result is a package-relative file path. */
function norm(p: string): string {
  return p.replace(/^\.?\//, "");
}

type ResolveOpts = { browser: boolean; conditions: string[]; require?: boolean };

/** Call resolve.exports, swallowing its "no known conditions" throw. */
function tryResolve(
  manifest: PackageManifest,
  entry: string,
  opts: ResolveOpts,
): string[] | undefined {
  try {
    return resolveExports(manifest, entry, opts) as string[] | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a package + subpath to the concrete file path inside the package,
 * honoring `package.json` `exports` conditions for the given `target`, with a
 * `main`/`module`/`browser` legacy fallback. Returns a package-relative path
 * (e.g. `"dist/index.js"`).
 */
export function resolveEntry(
  manifest: PackageManifest,
  subpath: string | undefined,
  target: ModuleTarget,
): string {
  const browser = target === "browser";
  const clean = (subpath ?? "").replace(/^\.?\//, "");
  const entry = clean ? `./${clean}` : ".";

  if (manifest.exports !== undefined) {
    const conditions = browser ? ["browser"] : ["node"];
    // resolve.exports *throws* when no condition matches — try ESM (import) then
    // CJS-only (require) exports maps, swallowing the no-match throw.
    const out =
      tryResolve(manifest, entry, { browser, conditions }) ??
      tryResolve(manifest, entry, { browser, conditions, require: true });
    if (out?.length) return norm(out[0]);
    // exports present but subpath not exported: fall through to the raw path.
  }

  if (entry === ".") {
    const leg = legacy(manifest, {
      browser,
      fields: browser ? ["browser", "module", "main"] : ["module", "main"],
    });
    if (typeof leg === "string") return norm(leg);
  }

  return clean || "index.js";
}
