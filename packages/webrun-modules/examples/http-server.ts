/**
 * unpkg-like HTTP service built on @statewalker/webrun-modules.
 *
 * Run (needs network for the first request per package):
 *   pnpm --filter @statewalker/webrun-modules exec tsx examples/http-server.ts
 *
 * Then, for any npm package, get an importable ESM script with its dependencies
 * already resolved to same-origin URLs:
 *
 *   curl -L  localhost:8787/debug            # bare spec → 302 → pinned entry → JS
 *   curl     'localhost:8787/lodash-es@4/merge'
 *   <script type="module">import ms from "http://localhost:8787/ms"; …</script>
 *
 * Endpoints:
 *   GET /{name}[@{range}][/{subpath}]        → 302 redirect to the pinned URL
 *   GET /{name}@{version}/{file}             → the transformed, importable ESM
 *   GET /{name}@{version}/{file}?raw         → the original untransformed bytes
 */

import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import semver from "semver";
import { newModuleServer, npmRegistrySource } from "../src/index.js";

const PORT = Number(process.env.PORT ?? 8787);
const cacheDir = await mkdtemp(join(tmpdir(), "webrun-modules-unpkg-"));

const server = newModuleServer({
  cache: new NodeFilesApi({ rootDir: cacheDir }),
  sources: [npmRegistrySource()],
  target: "browser", // serve browser-runnable ESM, like unpkg's ?module
});

/** Split an unpkg-style spec into { pkg, version?, subpath? }. */
function parseSpec(spec: string): { pkg: string; version?: string; subpath?: string } {
  let scope = "";
  let rest = spec;
  if (rest.startsWith("@")) {
    const i = rest.indexOf("/");
    scope = `${rest.slice(0, i)}/`;
    rest = rest.slice(i + 1);
  }
  const [nameVer, ...sub] = rest.split("/");
  const at = nameVer.indexOf("@");
  const pkg = scope + (at >= 0 ? nameVer.slice(0, at) : nameVer);
  const version = at >= 0 ? nameVer.slice(at + 1) : undefined;
  const subpath = sub.join("/") || undefined;
  return { pkg, version, subpath };
}

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/" || pathname === "") {
    return new Response("webrun-modules unpkg-like server — try /debug or /lodash-es@4/merge\n", {
      headers: { "content-type": "text/plain" },
    });
  }
  const spec = parseSpec(decodeURIComponent(pathname.slice(1)));
  // Already pinned (exact version + a file) → serve the transformed module directly.
  if (spec.version && semver.valid(spec.version) && spec.subpath) return server.fetch(request);
  // Otherwise resolve the spec to its pinned entry and redirect (unpkg-style).
  try {
    const resolved = await server.resolve(spec);
    return new Response(null, { status: 302, headers: { location: resolved.url } });
  } catch {
    return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  }
}

// Minimal Node http → Web-fetch adapter (no framework: server.fetch is standard).
const http = createServer(async (nodeReq, nodeRes) => {
  const url = `http://${nodeReq.headers.host ?? `localhost:${PORT}`}${nodeReq.url}`;
  const response = await handle(new Request(url, { method: nodeReq.method }));
  nodeRes.statusCode = response.status;
  response.headers.forEach((v, k) => {
    nodeRes.setHeader(k, v);
  });
  nodeRes.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
});

http.listen(PORT, async () => {
  console.log(`unpkg-like server on http://localhost:${PORT}  (cache: ${cacheDir})`);

  // Self-demo: fetch `debug` and show its dependencies resolved to local URLs.
  const bare = await fetch(`http://localhost:${PORT}/debug`, { redirect: "manual" });
  console.log(`\nGET /debug → ${bare.status} ${bare.headers.get("location")}`);
  const entry = await fetch(`http://localhost:${PORT}${bare.headers.get("location")}`);
  const js = await entry.text();
  const deps = [...new Set(js.match(/from "[.@][^"]+"/g) ?? [])].slice(0, 6);
  console.log(
    `GET ${bare.headers.get("location")} → ${entry.status} ${entry.headers.get("content-type")}`,
  );
  console.log("  resolved dependency imports in the served script:");
  for (const d of deps) console.log(`    … ${d}`);
  console.log(`\nReady. Try:  curl -L localhost:${PORT}/lodash-es@4/merge`);
});
