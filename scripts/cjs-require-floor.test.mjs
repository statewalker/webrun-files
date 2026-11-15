// A dependency that the CommonJS build `require`s (rolldown-external.mjs keeps it external once
// the installed version is requirable) must be requirable in every version the published range
// admits. Otherwise a consumer whose lockfile already holds an older, ESM-only release gets
// ERR_PACKAGE_PATH_NOT_EXPORTED when it requires the package (statewalker/statewalker-root#68).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cjsBundled } from "./rolldown-external.mjs";

/** First release of each dependency whose main entry can be `require`d. */
const REQUIRABLE_SINCE = {
  // statewalker/statewalker-db#50 added the `default` exports condition.
  "@statewalker/db-sqlite": "0.1.2",
  "@statewalker/db-api": "0.1.6",
};

const root = join(import.meta.dirname, "..");

function catalog() {
  const entries = {};
  let inCatalog = false;
  for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^catalog:\s*$/.test(line)) inCatalog = true;
    else if (/^\S/.test(line)) inCatalog = false;
    else if (inCatalog) {
      const m = /^\s+"?([^":]+)"?:\s*"?([^"\s]+)"?/.exec(line);
      if (m) entries[m[1]] = m[2];
    }
  }
  return entries;
}

const floor = (range) => {
  const m = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(m, `unsupported range ${range}`);
  return m.slice(1).map(Number);
};
const atLeast = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

test("every dependency a CJS build requires is requirable across its whole published range", () => {
  const cat = catalog();
  const problems = [];
  for (const name of readdirSync(join(root, "packages"))) {
    const dir = join(root, "packages", name);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (pkg.private) continue;
    const bundled = new Set(cjsBundled(dir));
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    for (const [dep, spec] of Object.entries(deps)) {
      const since = REQUIRABLE_SINCE[dep];
      if (!since || bundled.has(dep)) continue;
      const range = spec.startsWith("catalog:") ? cat[dep] : spec;
      if (!atLeast(floor(range), floor(since)))
        problems.push(`${pkg.name}: ${dep} ${range} admits releases before ${since}`);
    }
  }
  assert.deepEqual(problems, []);
});
