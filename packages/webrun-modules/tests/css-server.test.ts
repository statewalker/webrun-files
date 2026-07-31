import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

async function project(files: Record<string, string>) {
  const p = new MemFilesApi();
  for (const [k, v] of Object.entries(files)) await p.write(k, [new TextEncoder().encode(v)]);
  return p;
}

describe("CSS serving", () => {
  it("serves processed text/css at a bare .css url", async () => {
    const p = await project({ "/a.css": `.x { .y { color: red } }` });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const res = await server.fetch(new Request("http://h/~/a.css"));
    expect(res.headers.get("content-type")).toBe("text/css");
    expect(await res.text()).toMatch(/\.x \.y/); // processed
  });

  it('import "./a.css" resolves to ?module and serves a <style>-injecting JS module', async () => {
    const p = await project({
      "/app.js": `import "./a.css";\nexport const ok = 1;`,
      "/a.css": `.x { color: red }`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const app = await (await server.fetch(new Request("http://h/~/app.js"))).text();
    expect(app).toContain("a.css?module");
    const mod = await server.fetch(new Request("http://h/~/a.css?module"));
    expect(mod.headers.get("content-type")).toBe("text/javascript");
    const js = await mod.text();
    expect(js).toContain('createElement("style")');
    expect(js).toContain("appendChild");
  });

  it("a bare @import resolves DIRECTLY (no ~deps proxy) to a pinned package URL", async () => {
    // Minimal in-memory Source — no network (mirrors tests/server.test.ts's memSource pattern).
    const source: Source = {
      matches: (ref) => "pkg" in ref && ref.pkg === "some-pkg",
      async load(ref) {
        if (!("pkg" in ref)) throw new Error("bad ref");
        const files = new MemFilesApi();
        await files.write("/reset.css", [new TextEncoder().encode(`html { margin: 0 }`)]);
        return {
          name: "some-pkg",
          version: "1.0.0",
          files,
          manifest: { name: "some-pkg", version: "1.0.0" } as PackageManifest,
        };
      },
    };
    const p = await project({ "/main.css": `@import "some-pkg/reset.css";` });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, sources: [source] });
    const css = await (await server.fetch(new Request("http://h/~/main.css"))).text();
    expect(css).toContain("some-pkg@1.0.0/reset.css"); // direct pinned URL
    expect(css).not.toContain("~deps/"); // never proxied
  });

  it("resolveCssSpec passes an absolute/data: URL through unchanged", async () => {
    const p = await project({
      "/main.css": `@import "https://cdn.example.com/reset.css"; .a { background: url(data:image/png;base64,AAAA) }`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const css = await (await server.fetch(new Request("http://h/~/main.css"))).text();
    expect(css).toContain("https://cdn.example.com/reset.css"); // absolute URL untouched
    expect(css).toContain("data:image/png;base64,AAAA"); // data: URL untouched
  });

  it("CSS @import and url() targets are traversed by listResources", async () => {
    const p = await project({
      "/app.ts": `import "./main.css"; export const ok = 1;`,
      "/main.css": `@import "./base.css"; .a { background: url(./logo.svg) }`,
      "/base.css": `.b { color: blue }`,
      "/logo.svg": `<svg/>`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const urls = await server.listResources({ url: "/app.ts" });
    expect(urls.some((u) => u.endsWith("main.css"))).toBe(true);
    expect(urls.some((u) => u.endsWith("base.css"))).toBe(true);
    expect(urls.some((u) => u.endsWith("logo.svg"))).toBe(true);
  });

  it("a CSS @import cycle terminates and lists each file exactly once", async () => {
    const p = await project({
      "/app.ts": `import "./a.css"; export const ok = 1;`,
      "/a.css": `@import "./b.css"; .a { color: red }`,
      "/b.css": `@import "./a.css"; .b { color: blue }`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const urls = await server.listResources({ url: "/app.ts" }); // hangs (timeout) if the cycle isn't guarded
    expect(urls.filter((u) => u.endsWith("a.css")).length).toBe(1);
    expect(urls.filter((u) => u.endsWith("b.css")).length).toBe(1);
  });

  it("a bare-package CSS @import is traversed by listResources via the direct resolver (no ~deps proxy)", async () => {
    // Same in-memory Source pattern as the direct-resolution test above.
    const source: Source = {
      matches: (ref) => "pkg" in ref && ref.pkg === "some-pkg",
      async load(ref) {
        if (!("pkg" in ref)) throw new Error("bad ref");
        const files = new MemFilesApi();
        await files.write("/reset.css", [new TextEncoder().encode(`html { margin: 0 }`)]);
        return {
          name: "some-pkg",
          version: "1.0.0",
          files,
          manifest: { name: "some-pkg", version: "1.0.0" } as PackageManifest,
        };
      },
    };
    const p = await project({
      "/app.ts": `import "./main.css"; export const ok = 1;`,
      "/main.css": `@import "some-pkg/reset.css";`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, sources: [source] });
    const urls = await server.listResources({ url: "/app.ts" });
    expect(urls.some((u) => u.endsWith("some-pkg@1.0.0/reset.css"))).toBe(true); // direct endpoint
    expect(urls.some((u) => u.includes("~deps/"))).toBe(false); // never proxied
  });

  it("*.module.css import default-exports the scoped class map", async () => {
    const p = await project({
      "/app.ts": `import styles from "./s.module.css"; export const cls = styles.title;`,
      "/s.module.css": `.title { color: red }`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const mod = await (await server.fetch(new Request("http://h/~/s.module.css?module"))).text();
    expect(mod).toContain("export default {");
    expect(mod).toContain("title");
    expect(mod).toContain('createElement("style")'); // still injects
  });

  it("*.module.css with zero class selectors still default-exports the (empty) map, not the CSS string", async () => {
    const p = await project({
      "/app.ts": `import styles from "./e.module.css"; export const ok = styles;`,
      "/e.module.css": `:root { --x: 1 } body { margin: 0 }`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const mod = await (await server.fetch(new Request("http://h/~/e.module.css?module"))).text();
    expect(mod).toContain("export default {"); // the map, even though it's empty
    expect(mod).not.toMatch(/export default "/); // never the CSS text for a .module.css
  });

  it("Node target: importing a CSS module does not throw and evaluates cleanly (guarded injection)", async () => {
    const p = await project({
      "/x.css": `.a{color:red}`,
      "/app.ts": `import "./x.css"; export const ok = 1;`,
    });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, target: "node" });
    const mod = await (await server.fetch(new Request("http://h/~/x.css?module"))).text();
    // Actually EVALUATE the module in this document-less Node realm — proves the
    // `typeof document !== "undefined"` guard really gates the DOM call (a
    // substring check can't distinguish "gated" from "merely present in source").
    const evaluated: { default: string } = await import(
      `data:text/javascript,${encodeURIComponent(mod)}`
    );
    expect(typeof evaluated.default).toBe("string");
    expect(evaluated.default).toContain("color: red");
  });
});
