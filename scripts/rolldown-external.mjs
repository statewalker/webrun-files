// The `external` option of every package's rolldown.config.js (statewalker/webrun-files#49):
// everything the package declares as a dependency, peer or optional dependency (and their
// subpaths), and Node built-ins, stays an import; only the package's own `src/` is bundled.
// Bundling a dependency would hand consumers a second copy of it and make every compatible
// update of it change `dist`, which republishes the package.
import fs from "node:fs";
import path from "node:path";

/** `external` for the package in `dir` (the config's directory, `import.meta.dirname`). */
export function externalFor(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const deps = Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  });
  return (id) => id.startsWith("node:") || deps.some((d) => id === d || id.startsWith(`${d}/`));
}
