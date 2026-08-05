import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

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
});
