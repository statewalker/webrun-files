import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

type Pkg = { version: string; manifest: Partial<PackageManifest>; files: Record<string, string> };

/** In-memory Source: serves fixed packages from a map (no network). */
function memSource(pkgs: Record<string, Pkg>): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const p = pkgs[ref.pkg];
      const files = new MemFilesApi();
      for (const [path, content] of Object.entries(p.files))
        await writeText(files, `/${path}`, content);
      return {
        name: ref.pkg,
        version: p.version,
        files,
        manifest: { name: ref.pkg, version: p.version, ...p.manifest } as PackageManifest,
      };
    },
  };
}

const PKGS: Record<string, Pkg> = {
  greet: {
    version: "1.0.0",
    manifest: { type: "module", main: "./index.js" },
    files: { "index.js": `import { up } from "shout";\nexport const hi = (n) => up("hi " + n);` },
  },
  shout: {
    version: "2.3.1",
    manifest: { type: "module", main: "./index.js" },
    files: { "index.js": `export const up = (s) => s.toUpperCase();` },
  },
  "@jspm/core": {
    version: "2.1.0",
    manifest: {},
    files: { "nodelibs/browser/path.js": `export const sep = "/";` },
  },
  docs: {
    version: "1.0.0",
    manifest: { type: "module", main: "./index.js" },
    files: {
      "index.js": `export const x = 1;`,
      "README.md": `# Docs\n\nA package.`,
      "data.json": `{"k":1}`,
    },
  },
  usenode: {
    version: "1.0.0",
    manifest: { type: "module", main: "./index.js" },
    files: { "index.js": `import { sep } from "node:path";\nexport const s = sep;` },
  },
};

const mk = (opts: Partial<Parameters<typeof newModuleServer>[0]> = {}) =>
  newModuleServer({ cache: new MemFilesApi(), sources: [memSource(PKGS)], ...opts });
const req = (path: string) => new Request(`http://x${path}`);

describe("newModuleServer", () => {
  it("resolves an npm package to a pinned /{name}@{version}/{file} URL", async () => {
    const s = mk();
    const r = await s.resolve({ pkg: "greet" });
    expect(r.url).toBe("/greet@1.0.0/index.js");
    expect(r.target).toBe("browser");
  });

  it("fetch serves transformed ESM with bare imports rewritten to relative local URLs", async () => {
    const s = mk();
    const res = await s.fetch(req("/greet@1.0.0/index.js"));
    expect(res.headers.get("content-type")).toBe("text/javascript");
    const body = await res.text();
    expect(body).toContain(`from "../shout@2.3.1/index.js"`);
    expect(body).not.toContain(`from "shout"`); // no bare specifier survives
  });

  it("prime warms the whole graph; served output is all same-origin (no CDN / bare)", async () => {
    const s = mk();
    await s.prime({ pkg: "greet" });
    for (const id of ["greet@1.0.0/index.js", "shout@2.3.1/index.js"]) {
      const body = await (await s.fetch(req(`/${id}`))).text();
      expect(body).not.toMatch(/from "[a-z@]/); // no bare specifier
      expect(body).not.toMatch(/esm\.sh|jsdelivr|unpkg|registry\.npmjs/);
    }
  });

  it("maps node:path to a same-origin @jspm/core polyfill under browser target", async () => {
    const s = mk();
    const body = await (await s.fetch(req("/usenode@1.0.0/index.js"))).text();
    expect(body).toContain(`from "../@jspm/core@2.1.0/nodelibs/browser/path.js"`);
    expect(body).not.toContain(`from "node:path"`);
  });

  it("mounts under a basePath: URLs carry the prefix and requests resolve", async () => {
    const s = mk({ basePath: "/deps/v1/" });
    const r = await s.resolve({ pkg: "greet" });
    expect(r.url).toBe("/deps/v1/greet@1.0.0/index.js");
    const res = await s.fetch(req("/deps/v1/greet@1.0.0/index.js"));
    expect(res.status).toBe(200);
    // relative internal imports keep the same cached bytes portable across prefixes
    expect(await res.text()).toContain(`from "../shout@2.3.1/index.js"`);
  });

  it("serves raw untransformed bytes with ?raw, distinct from transformed", async () => {
    const s = mk();
    await s.resolve({ pkg: "greet" }); // warm the raw cache
    const raw = await (await s.fetch(req("/greet@1.0.0/index.js?raw"))).text();
    expect(raw).toBe(`import { up } from "shout";\nexport const hi = (n) => up("hi " + n);`);
  });

  it("returns 404 (not a throw) for an unresolvable path", async () => {
    const s = mk();
    const res = await s.fetch(req("/does-not-exist@9.9.9/x.js"));
    expect(res.status).toBe(404);
  });

  it("resolves a local project script and rewrites its bare imports", async () => {
    const projectFs = new MemFilesApi();
    await writeText(
      projectFs,
      "/src/app.ts",
      `import { hi } from "greet";\nexport const out: string = hi("x");`,
    );
    const s = mk({ project: projectFs });
    const r = await s.resolve({ url: "/src/app.ts" });
    expect(r.url).toBe("/~/src/app.ts");
    const body = await (await s.fetch(req("/~/src/app.ts"))).text();
    expect(body).toContain(`from "../../greet@1.0.0/index.js"`);
    expect(body).not.toContain(": string"); // TS stripped
  });

  it("dedupes to one version per package name in the lock", async () => {
    const s = mk();
    await s.prime({ pkg: "greet" });
    expect(s.lock).toEqual({ greet: "1.0.0", shout: "2.3.1" });
  });

  it("listResources returns the reachable module URLs from an entry", async () => {
    const s = mk();
    const urls = await s.listResources({ pkg: "greet" });
    expect(urls).toEqual(["/greet@1.0.0/index.js", "/shout@2.3.1/index.js"]);
  });

  it("listResources carries the basePath prefix", async () => {
    const s = mk({ basePath: "/deps/v1/" });
    const urls = await s.listResources({ pkg: "greet" });
    expect(urls).toContain("/deps/v1/shout@2.3.1/index.js");
  });

  it("listPackageFiles lists a package's full file set (not just reachable)", async () => {
    const s = mk();
    const files = await s.listPackageFiles({ pkg: "greet" });
    expect(files).toEqual(["index.js", "package.json"]);
  });

  it("serves non-module files raw with a guessed content-type (not transformed)", async () => {
    const s = mk();
    await s.resolve({ pkg: "docs" }); // warm the raw cache
    const md = await s.fetch(req("/docs@1.0.0/README.md"));
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown");
    expect(await md.text()).toBe("# Docs\n\nA package.");

    const json = await s.fetch(req("/docs@1.0.0/package.json"));
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(await json.text()).name).toBe("docs");

    const data = await s.fetch(req("/docs@1.0.0/data.json"));
    expect(data.headers.get("content-type")).toBe("application/json");

    // the JS module is still transformed:
    const js = await s.fetch(req("/docs@1.0.0/index.js"));
    expect(js.headers.get("content-type")).toBe("text/javascript");
  });
});
