import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import semver from "semver";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

const req = (p: string) => new Request(`http://x${p}`);

/** A source serving multiple versions of packages, counting each load. */
function multiSource(
  pkgs: Record<string, Record<string, Record<string, string>>>,
  counter: { n: number },
): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      counter.n++;
      const vers = Object.keys(pkgs[ref.pkg]);
      const spec = ref.version ?? "*";
      const version = semver.maxSatisfying(vers, semver.validRange(spec) ? spec : "*") ?? spec;
      const files = new MemFilesApi();
      for (const [p, c] of Object.entries(pkgs[ref.pkg][version] ?? {}))
        await writeText(files, `/${p}`, c);
      return {
        name: ref.pkg,
        version,
        files,
        manifest: { name: ref.pkg, version, type: "module", main: "./index.js" } as PackageManifest,
      };
    },
  };
}

const LIB = {
  lib: {
    "1.2.0": { "index.js": `export const v = "1.2.0";` },
    "2.1.0": { "index.js": `export const v = "2.1.0";` },
  },
  app: { "1.0.0": { "index.js": `import { v } from "lib";\nexport const app = v;` } },
};

describe("version dedupe & lockfile", () => {
  it("dedupes compatible ranges to one loaded version", async () => {
    const counter = { n: 0 };
    const s = newModuleServer({ cache: new MemFilesApi(), sources: [multiSource(LIB, counter)] });
    const a = await s.resolve({ pkg: "lib", version: "^1.0.0" });
    const b = await s.resolve({ pkg: "lib", version: "~1.2.0" });
    expect(a.url).toBe("/lib@1.2.0/index.js");
    expect(b.url).toBe(a.url);
    expect(counter.n).toBe(1); // second compatible request reused the lock
    expect(s.lock).toEqual({ lib: "1.2.0" });
  });

  it("keeps incompatible versions side by side; the first stays primary", async () => {
    const counter = { n: 0 };
    const s = newModuleServer({ cache: new MemFilesApi(), sources: [multiSource(LIB, counter)] });
    const one = await s.resolve({ pkg: "lib", version: "^1.0.0" });
    const two = await s.resolve({ pkg: "lib", version: "^2.0.0" });
    expect(one.url).toBe("/lib@1.2.0/index.js");
    expect(two.url).toBe("/lib@2.1.0/index.js"); // both served
    expect(s.lock).toEqual({ lib: "1.2.0" }); // primary unchanged
  });

  it("honors a seeded lock on a cold cache (pins, does not fall to latest)", async () => {
    const counter = { n: 0 };
    const s = newModuleServer({
      cache: new MemFilesApi(),
      sources: [multiSource(LIB, counter)],
      lock: { lib: "1.2.0" }, // pin an older version than latest (2.1.0)
    });
    const r = await s.resolve({ pkg: "lib" }); // bare ref would be latest without the lock
    expect(r.url).toBe("/lib@1.2.0/index.js");
  });

  it("persists the lockfile; a reload does not re-solve", async () => {
    const cache = new MemFilesApi();
    const counter = { n: 0 };
    const a = newModuleServer({ cache, sources: [multiSource(LIB, counter)] });
    await a.prime({ pkg: "app" });
    const afterFirst = counter.n; // loaded app + lib
    // app bare-imports "lib" → resolves to latest (2.1.0)
    expect(a.lock).toEqual({ app: "1.0.0", lib: "2.1.0" });

    const b = newModuleServer({ cache, sources: [multiSource(LIB, counter)] });
    await b.prime({ pkg: "app" });
    expect(b.lock).toEqual({ app: "1.0.0", lib: "2.1.0" }); // loaded from /lock.json
    expect(counter.n).toBe(afterFirst); // no new source loads on reload
  });
});

/** A source with per-version files + declared dependencies. */
function nestSource(
  pkgs: Record<string, Record<string, { files: Record<string, string>; deps?: Record<string, string> }>>,
): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const vers = Object.keys(pkgs[ref.pkg]);
      const spec = ref.version ?? "*";
      const version = semver.maxSatisfying(vers, semver.validRange(spec) ? spec : "*") ?? spec;
      const entry = pkgs[ref.pkg][version];
      const files = new MemFilesApi();
      for (const [p, c] of Object.entries(entry.files)) await writeText(files, `/${p}`, c);
      return {
        name: ref.pkg,
        version,
        files,
        manifest: {
          name: ref.pkg,
          version,
          type: "module",
          main: "./index.js",
          dependencies: entry.deps ?? {},
        } as PackageManifest,
      };
    },
  };
}

const NEST = {
  self: {
    "1.0.0": { files: { "index.js": `export const v = "1.0.0";`, "sub/inner.js": `export { v } from "self";` } },
    "2.0.0": { files: { "index.js": `export const v = "2.0.0";` } },
  },
  app: {
    "1.0.0": { files: { "index.js": `export { v } from "lib";` }, deps: { lib: "^1.0.0" } },
  },
  lib: {
    "1.2.0": { files: { "index.js": `export const v = "1.2.0";` } },
    "2.1.0": { files: { "index.js": `export const v = "2.1.0";` } },
  },
};

describe("importer-context version resolution", () => {
  it("resolves a package's self-reference to its own version (not latest)", async () => {
    const s = newModuleServer({ cache: new MemFilesApi(), sources: [nestSource(NEST)] });
    const body = await (await s.fetch(req("/self@1.0.0/sub/inner.js"))).text();
    expect(body).toContain(`from "./~deps/inner.js/deps.self.js"`); // proxy indirection
    // the proxy re-exports self@1.0.0's own index (relative, within its tree), not @2.0.0
    const proxy = await (await s.fetch(req("/self@1.0.0/sub/~deps/inner.js/deps.self.js"))).text();
    expect(proxy).toContain(`../../../index.js`); // self@1.0.0's own index, relative
    expect(proxy).not.toContain("self@2.0.0"); // not the global latest
  });

  it("resolves a dependency to the importer's declared range (not latest)", async () => {
    const s = newModuleServer({ cache: new MemFilesApi(), sources: [nestSource(NEST)] });
    const body = await (await s.fetch(req("/app@1.0.0/index.js"))).text();
    expect(body).toContain(`from "./~deps/index.js/deps.lib.js"`); // proxy indirection
    const proxy = await (await s.fetch(req("/app@1.0.0/~deps/index.js/deps.lib.js"))).text();
    expect(proxy).toContain(`lib@1.2.0/index.js`); // app's ^1.0.0 → 1.2.0
    expect(proxy).not.toContain("lib@2.1.0"); // not the global latest
  });
});

describe("lazy download-on-request (no install step)", () => {
  it("a direct fetch of a never-primed package downloads it once, then caches", async () => {
    const counter = { n: 0 };
    const s = newModuleServer({ cache: new MemFilesApi(), sources: [multiSource(LIB, counter)] });
    // No resolve, no prime — just fetch. It must download + transform + serve.
    const first = await s.fetch(req("/app@1.0.0/index.js"));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/javascript");
    expect(counter.n).toBeGreaterThan(0); // the package was fetched on demand
    const loadsAfterFirst = counter.n;
    // A second request is served from cache — no new source load.
    await s.fetch(req("/app@1.0.0/index.js"));
    expect(counter.n).toBe(loadsAfterFirst);
  });
});

describe("isomorphic parity (NodeFilesApi real disk)", () => {
  it("the same server code works over a real-disk FilesApi cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wm-node-"));
    const cache = new NodeFilesApi({ rootDir: dir });
    const counter = { n: 0 };
    const s = newModuleServer({ cache, sources: [multiSource(LIB, counter)] });
    const r = await s.resolve({ pkg: "app" });
    expect(r.url).toBe("/app@1.0.0/index.js");
    const body = await (await s.fetch(req("/app@1.0.0/index.js"))).text();
    expect(body).toContain(`from "./~deps/index.js/deps.lib.js"`); // proxy indirection on disk
    // the proxy (also cached on real disk) re-exports the pinned endpoint (latest lib)
    const proxy = await (await s.fetch(req("/app@1.0.0/~deps/index.js/deps.lib.js"))).text();
    expect(proxy).toContain("lib@2.1.0/index.js");
    expect(await readText(cache, "/t/browser/app@1.0.0/~deps/index.js/deps.lib.js")).toContain(
      "lib@2.1.0/index.js",
    );
  });
});
