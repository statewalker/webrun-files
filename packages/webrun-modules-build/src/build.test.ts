import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { PackageManifest, Source } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

type Pkg = { version: string; manifest: Partial<PackageManifest>; files: Record<string, string> };

/** In-memory Source serving fixed packages (no network) — mirrors server.test.ts. */
function memSource(pkgs: Record<string, Pkg>): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const p = pkgs[ref.pkg];
      if (!p) throw new Error(`no pkg ${ref.pkg}`);
      const files = new MemFilesApi();
      for (const [path, content] of Object.entries(p.files)) {
        await writeText(files, `/${path}`, content);
      }
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
};

describe("newProjectBuild — golden batch build", () => {
  it("emits a static .js tree with ext-mapped imports + a ~deps proxy for a bare dep", async () => {
    const project = new MemFilesApi();
    await writeText(
      project,
      "/main.tsx",
      `import { hi } from "greet";\nimport { u } from "./util.ts";\nexport const out: string = hi(u);`,
    );
    await writeText(project, "/util.ts", `export const u = "x";`);
    const cache = new MemFilesApi();

    const { served } = await newProjectBuild({
      project,
      cache,
      sources: [memSource(PKGS)],
    }).build();

    // Entry emitted as an ext-mapped `.js` — imports rewritten, TS stripped.
    expect(await cache.exists("/~/main.js")).toBe(true);
    const main = await readText(cache, "/~/main.js");
    expect(main).toContain(`from "./util.js"`); // sibling ext-mapped .ts → .js
    expect(main).toContain(`from "./~deps/main.tsx/deps.greet.js"`); // bare dep → proxy
    expect(main).not.toContain(`from "greet"`); // no bare specifier survives
    expect(main).not.toContain(`: string`); // TS stripped

    // The reachable project dependency is emitted too.
    expect(await cache.exists("/~/util.js")).toBe(true);

    // The `~deps` proxy body — a walk side-effect into cache — re-exports the
    // resolved npm endpoint (same proxy naming the server produces).
    expect(await cache.exists("/~/~deps/main.tsx/deps.greet.js")).toBe(true);
    const proxy = await readText(cache, "/~/~deps/main.tsx/deps.greet.js");
    expect(proxy).toContain(`greet@1.0.0/index.js`);

    // The served pointer names the emitted entry artifact.
    expect(served).toContain("/~/main.js");
  });
});
