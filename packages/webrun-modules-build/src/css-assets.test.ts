import { readFile, readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

describe("newProjectBuild — F2 @import-chained CSS", () => {
  it("emits a real /~/b.css alongside the a.js injector, keeping the @import specifier", async () => {
    const project = new MemFilesApi();
    await writeText(
      project,
      "/main.tsx",
      `import "./a.css";\nexport const x = 1;`,
    );
    await writeText(project, "/a.css", `@import "./b.css";\n.a { color: red; }`);
    await writeText(project, "/b.css", `.b { color: blue; }`);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();

    // (i) a.js injector exists and its embedded CSS still references ./b.css.
    expect(await cache.exists("/~/a.js")).toBe(true);
    const aJs = await readText(cache, "/~/a.js");
    expect(aJs).toContain(`./b.css`);

    // (ii) a REAL processed b.css exists at /~/b.css with b's rule.
    expect(await cache.exists("/~/b.css")).toBe(true);
    const bCss = await readText(cache, "/~/b.css");
    expect(bCss).toContain(".b");
    expect(bCss).toContain("color"); // b's rule, processed (lightningcss minifies blue → #00f)
  });
});

describe("newProjectBuild — F3 url() asset references", () => {
  it("copies a url()-referenced asset verbatim to its ext-map path", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./a.css";\nexport const x = 1;`);
    await writeText(project, "/a.css", `.a { background: url("./logo.png"); }`);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    await project.write("/logo.png", [bytes]);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();

    // The asset is emitted at its ext-map path (non-code ext left unchanged).
    expect(await cache.exists("/~/logo.png")).toBe(true);
    const out = await readFile(cache, "/~/logo.png");
    expect([...out]).toEqual([...bytes]); // byte-identical copy, no transform
  });
});

/** A couple of ms so the scanner sees a distinct mtime after the removal. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("newProjectBuild — Prune F2 .css orphan", () => {
  it("removes the F2 raw /~/b.css alongside /~/b.js when the source is deleted", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./a.css";\nexport const x = 1;`);
    await writeText(project, "/a.css", `@import "./b.css";\n.a { color: red; }`);
    await writeText(project, "/b.css", `.b { color: blue; }`);
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project, cache });

    await build.build();
    expect(await cache.exists("/~/b.js")).toBe(true);
    expect(await cache.exists("/~/b.css")).toBe(true);

    await tick();
    await project.remove("/b.css");
    await build.build();

    // Both the wrapped `.js` and the F2 raw `.css` are pruned — no orphan left.
    expect(await cache.exists("/~/b.js")).toBe(false);
    expect(await cache.exists("/~/b.css")).toBe(false);
  });
});
