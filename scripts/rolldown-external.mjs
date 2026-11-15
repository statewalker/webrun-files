// The `external` option of every package's rolldown.config.js (statewalker/webrun-files#49):
// everything the package declares as a dependency, peer or optional dependency (and their
// subpaths), and Node built-ins, stays an import; only the package's own `src/` is bundled.
// Bundling a dependency would hand consumers a second copy of it and make every compatible
// update of it change `dist`, which republishes the package.
//
// One exception, in CommonJS output only: a dependency that cannot be `require`d (its `exports`
// has no `require` or `default` condition, such as an ESM-only @statewalker/db-sqlite) is still
// bundled there, or the package's CJS entry would throw on load. `cjsBundled()` lists them so the
// check (scripts/check-bundled-deps.mjs) allows exactly those.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const manifest = (dir) => JSON.parse(fs.readFileSync(path.resolve(dir, "package.json"), "utf8"));
const declared = (pkg) =>
  Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });

/** Whether a dependency's main entry resolves under the `require` condition. */
function requirable(dir, name) {
  // Found through the node_modules search paths, not `require.resolve("<name>/package.json")`:
  // a package's `exports` need not expose its package.json.
  const found = (createRequire(path.resolve(dir, "package.json")).resolve.paths(name) ?? [])
    .map((base) => path.join(base, name, "package.json"))
    .find((file) => fs.existsSync(file));
  if (!found) return true; // not installed here (e.g. an optional peer): leave it external
  const depPkg = JSON.parse(fs.readFileSync(found, "utf8"));
  const main =
    typeof depPkg.exports === "object" && depPkg.exports !== null
      ? (depPkg.exports["."] ?? depPkg.exports)
      : depPkg.exports;
  if (main === undefined) return true; // no `exports`: `main` applies
  if (typeof main === "string") return true;
  const conditions = JSON.stringify(main);
  return /"(require|default|node)"/.test(conditions);
}

/** The declared dependencies of the package in `dir` that CJS output must bundle. */
export function cjsBundled(dir) {
  return declared(manifest(dir)).filter((name) => !requirable(dir, name));
}

/** `external` for the package in `dir` (the config's directory, `import.meta.dirname`). */
export function externalFor(dir, { format = "esm" } = {}) {
  const bundled = format === "cjs" ? new Set(cjsBundled(dir)) : new Set();
  const deps = declared(manifest(dir)).filter((name) => !bundled.has(name));
  return (id) => id.startsWith("node:") || deps.some((d) => id === d || id.startsWith(`${d}/`));
}
