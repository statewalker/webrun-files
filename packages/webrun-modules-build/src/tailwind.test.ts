import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { type CssTransform, newDefaultCssTransform } from "@statewalker/webrun-modules";
import { afterEach, describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

/** A CSS transform that delegates to the real one but counts the *generic*
 *  Tailwind generation pass — the only call whose source is the multi-MB
 *  all-classes stylesheet (project stylesheets + specifier-capture passes are tiny).
 *  `big` is the reliable signal that `generateTailwindCss` actually ran. */
function spyCss(): CssTransform & { big: number } {
  const real = newDefaultCssTransform();
  const spy = {
    big: 0,
    transform(file: Parameters<CssTransform["transform"]>[0], rewrite: (s: string) => string) {
      if (file.source.length > 100_000) spy.big++;
      return real.transform(file, rewrite);
    },
  };
  return spy;
}

/** MemFilesApi stamps `lastModified` with `Date.now()`; a couple of ms guarantees
 *  the scanner sees a distinct mtime after a same-bytes touch. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("newProjectBuild — Tailwind transform (build-only)", () => {
  it("emits a /~/styles.js injector whose embedded CSS carries the generic utilities", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./styles.css";\nexport const x = 1;`);
    await writeText(project, "/styles.css", `@tailwind base;\n@tailwind utilities;`);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();

    // The CSS import is wrapped into a `.js` <style> injector; its embedded CSS is
    // the generic all-classes Tailwind stylesheet (independent of the source's
    // directives), so known utilities are present.
    expect(await cache.exists("/~/styles.js")).toBe(true);
    const injector = await readText(cache, "/~/styles.js");
    expect(injector).toContain(".flex");
    expect(injector).toContain(".p-4");
  });

  it('suppresses the bare `@import "tailwindcss"` so the walk never npm-resolves it', async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./styles.css";\nexport const x = 1;`);
    await writeText(project, "/styles.css", `@import "tailwindcss";`);
    const cache = new MemFilesApi();

    // Empty `sources`: any real npm resolution of `tailwindcss` would throw. The
    // build must complete without one — the transform generated the stylesheet and
    // walk suppressed the bare specifier — and still emit the generic utilities.
    await expect(newProjectBuild({ project, cache, sources: [] }).build()).resolves.toBeDefined();

    const injector = await readText(cache, "/~/styles.js");
    expect(injector).toContain(".flex");
  });

  it("honors the project's @theme customizations through the full build", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./styles.css";\nexport const x = 1;`);
    await writeText(
      project,
      "/styles.css",
      `@import "tailwindcss";\n@theme { --color-brand: #123456; }`,
    );
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();

    // The custom token yields a real `bg-brand` utility carrying the project value —
    // proof the entry source (not a fixed default theme) drove generation.
    const injector = await readText(cache, "/~/styles.js");
    expect(injector).toContain("bg-brand");
    expect(injector).toContain("#123456");
  });
});

describe("newProjectBuild — Tailwind inputs-only cache key", () => {
  afterEach(() => {
    delete process.env.TW_CACHE_VER;
  });

  it("(A) an unchanged tailwind input is not re-generated on the second build", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./styles.css";\nexport const x = 1;`);
    await writeText(project, "/styles.css", `@tailwind base;\n@tailwind utilities;`);
    const cache = new MemFilesApi();
    const css = spyCss();
    const build = newProjectBuild({ project, cache, css });

    await build.build();
    expect(css.big).toBeGreaterThanOrEqual(1); // generated once

    const before = css.big;
    await tick();
    await writeText(project, "/styles.css", `@tailwind base;\n@tailwind utilities;`); // same bytes, new mtime
    await build.build();

    // Scanner re-surfaces styles.css, but the hash gate (version + source unchanged)
    // reuses the artifact — no re-generation.
    expect(css.big).toBe(before);
  });

  it("(B) bumping the version seam re-generates with unchanged entry bytes", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./styles.css";\nexport const x = 1;`);
    await writeText(project, "/styles.css", `@tailwind base;\n@tailwind utilities;`);
    const cache = new MemFilesApi();
    const css = spyCss();
    const build = newProjectBuild({ project, cache, css });

    await build.build();
    const before = css.big;

    process.env.TW_CACHE_VER = "9.9.9"; // bump the pinned version; bytes untouched
    await tick();
    await writeText(project, "/styles.css", `@tailwind base;\n@tailwind utilities;`); // same bytes, new mtime
    await build.build();

    // The version is folded into the gate key, so the hash differs and Tailwind
    // regenerates despite byte-identical entry.
    expect(css.big).toBeGreaterThan(before);
  });
});
