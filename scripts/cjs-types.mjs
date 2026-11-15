// Types for the CommonJS build: copies the declarations tsc emitted into dist/ (dist/**/*.d.ts,
// outside dist/esm and dist/cjs) to dist/cjs/**/*.d.cts, with relative specifiers rewritten from
// `.js` to `.cjs`. The package's `require` condition points its `types` at dist/cjs/index.d.cts, so
// TypeScript reads the CJS entry as CommonJS instead of as ESM (attw's FalseESM, "Masquerading as
// ESM"). Run from the package's directory after `tsc --emitDeclarationOnly`.
//
//   node ../../scripts/cjs-types.mjs [packageDir]

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Relative specifiers in `from "…"`, `import("…")` and `import "…"`, ending in `.js`. */
const RELATIVE_JS = /((?:\bfrom|\bimport\s*\(|\bimport)\s*["'])(\.{1,2}\/[^"']*?)\.js(["'])/g;

/** The declaration text for the CJS copy: `.js` → `.cjs` in relative specifiers, no source map. */
export function toCts(text) {
  return text
    .replace(RELATIVE_JS, "$1$2.cjs$3")
    .replace(/^\/\/# sourceMappingURL=.*$/m, "")
    .trimEnd()
    .concat("\n");
}

function* declarations(dist, dir = dist) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const top = relative(dist, path);
      if (top === "cjs" || top === "esm") continue;
      yield* declarations(dist, path);
    } else if (entry.name.endsWith(".d.ts")) {
      yield path;
    }
  }
}

/** Writes dist/cjs/**\/*.d.cts for the package in `packageDir`; returns how many files. */
export function writeCjsTypes(packageDir) {
  const dist = resolve(packageDir, "dist");
  let count = 0;
  for (const file of declarations(dist)) {
    const target = join(dist, "cjs", relative(dist, file)).replace(/\.d\.ts$/, ".d.cts");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, toCts(readFileSync(file, "utf8")));
    count++;
  }
  if (count === 0) throw new Error(`cjs-types: no declarations in ${dist} (run tsc first)`);
  return count;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeCjsTypes(process.argv[2] ?? process.cwd());
}
