/**
 * Full life-cycle example for @statewalker/webrun-modules.
 *
 * Run against the live npm registry (needs network):
 *   pnpm --filter @statewalker/webrun-modules exec tsx examples/full-cycle.ts
 *
 * Demonstrates, end to end:
 *   1. lazy download-on-request — fetch a package that was never primed
 *   2. resolve — a bare specifier → an importable local URL
 *   3. prime — download + transform a whole dependency graph up front
 *   4. execute — import a served module and run it (no runtime CDN)
 *   5. ?raw — the untransformed bytes of any file
 *   6. the lockfile — the persisted resolution map
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readText } from "@statewalker/webrun-files";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newModuleServer, npmRegistrySource } from "../src/index.js";

const cacheDir = await mkdtemp(join(tmpdir(), "webrun-modules-example-"));
const req = (path: string) => new Request(`http://localhost${path}`);

// A server whose cache lives on real disk. target:"node" keeps Node builtins
// external so the served modules execute directly in this process.
const server = newModuleServer({
  cache: new NodeFilesApi({ rootDir: cacheDir }),
  sources: [npmRegistrySource()],
  target: "node",
});

// Import a served module straight from the on-disk cache (the transformed tree
// lives at {cacheDir}/t/node/{id}). Relative imports resolve on disk.
const importServed = (url: string) =>
  import(pathToFileURL(join(cacheDir, "t", "node", url.replace(/^\//, ""))).href);

try {
  // 1. LAZY DOWNLOAD-ON-REQUEST — no prime, no resolve: just fetch the URL.
  //    The package is downloaded + transformed on demand.
  console.log("1. Lazy fetch of a never-primed package (ms)…");
  const res = await server.fetch(req("/ms@2.1.3/index.js"));
  console.log(`   → ${res.status} ${res.headers.get("content-type")}`);
  const ms = (await importServed("/ms@2.1.3/index.js")).default;
  console.log(`   executed: ms("2 days") = ${ms("2 days")}  (expect 172800000)\n`);

  // 2. RESOLVE a bare specifier (range) → a pinned, importable URL.
  console.log("2. Resolve a package by range…");
  const resolved = await server.resolve({ pkg: "debug", version: "^4" });
  console.log(`   → ${resolved.url}\n`);

  // 3. PRIME the whole graph (debug pulls in ms + Node builtins).
  console.log("3. Prime the whole dependency graph…");
  const entry = await server.prime({ pkg: "debug", version: "^4" });
  console.log(`   entry: ${entry.url}`);

  // 4. EXECUTE the primed entry — resolved + transformed, no runtime CDN.
  const debug = (await importServed(entry.url)).default;
  const log = debug("example");
  console.log(`   executed: typeof debug("example") = ${typeof log}  (expect function)\n`);

  // 5. ?raw — the original, untransformed bytes of any file.
  console.log("5. Raw file access (?raw)…");
  const raw = await (await server.fetch(req("/ms@2.1.3/index.js?raw"))).text();
  console.log(`   raw ms/index.js starts with: ${JSON.stringify(raw.slice(0, 40))}…\n`);

  // 6. The lockfile — the persisted resolution map (also written to the cache).
  console.log("6. Lockfile (persisted resolution map):");
  console.log(`   in memory: ${JSON.stringify(server.lock)}`);
  const onDisk = await readText(new NodeFilesApi({ rootDir: cacheDir }), "/lock.json");
  console.log(`   on disk (${cacheDir}/lock.json): ${onDisk}`);

  console.log(
    "\n✓ Full cycle complete — packages downloaded, transformed, executed, with no runtime CDN.",
  );
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
