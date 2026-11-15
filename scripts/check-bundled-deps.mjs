#!/usr/bin/env node
// Every package's build must import its dependencies, not contain them (statewalker/webrun-files#49).
// Rolldown marks each module it puts in a bundle with a `// <path>` comment. In a correct build
// every such path is under the package's own `src/`; a path into node_modules or a sibling
// package (`../webrun-files/...`) means a dependency was bundled: consumers get a second copy of
// it, and every compatible update of it changes `dist`, which republishes the package.
//
// Run after `pnpm run build`, from the repository root: node scripts/check-bundled-deps.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MARKER = /^\/\/ (\S+\.(?:[cm]?[jt]sx?))$/gm;
let checked = 0;
const problems = [];
for (const name of fs.readdirSync(path.join(root, "packages")).sort()) {
  const dist = path.join(root, "packages", name, "dist");
  for (const entry of ["esm/index.js", "cjs/index.cjs"]) {
    const file = path.join(dist, entry);
    if (!fs.existsSync(file)) continue;
    checked++;
    // `\0rolldown/runtime.js` is rolldown's own interop helper, not a dependency.
    const foreign = [
      ...new Set(
        [...fs.readFileSync(file, "utf8").matchAll(MARKER)]
          .map((m) => m[1])
          .filter((p) => !p.startsWith("src/") && !p.startsWith("\\0rolldown/")),
      ),
    ];
    if (foreign.length)
      problems.push(`packages/${name}/dist/${entry} bundles: ${foreign.join(", ")}`);
  }
}
if (checked === 0) {
  console.error(
    "check-bundled-deps: no dist/esm/index.js or dist/cjs/index.cjs found; run `pnpm run build` first",
  );
  process.exit(1);
}
if (problems.length) {
  console.error(
    `check-bundled-deps: dependencies bundled into dist (mark them external in rolldown.config.js):\n  ${problems.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`check-bundled-deps: ${checked} bundles import their dependencies`);
