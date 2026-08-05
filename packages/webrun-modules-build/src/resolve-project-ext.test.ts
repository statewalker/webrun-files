import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

/**
 * Regression: a `.ts`/`.tsx` module imported via a `.js` specifier (the standard
 * ESM-with-.js convention) that is ALSO a scanned entry must emit its REAL output,
 * not be overwritten with empty. Before the fix, `resolveRelativeId` returned the
 * literal `~/app.js` (no such source → empty) which collided with the real
 * `~/app.ts` → `/~/app.js` emission and, depending on emit order, won.
 */
describe("newProjectBuild — project .js import resolves to the .ts/.tsx source", () => {
  it("emits non-empty output for an intermediate module imported via ./x.js", async () => {
    const project = new MemFilesApi();
    // main → ./app.js (app.ts) → ./store.js (store.ts); app is the intermediate.
    await writeText(
      project,
      "/main.ts",
      `import { hello } from "./app.js";\nconsole.log(hello());`,
    );
    await writeText(
      project,
      "/app.ts",
      `import { tag } from "./store.js";\nexport const hello = () => "hi " + tag();`,
    );
    await writeText(project, "/store.ts", `export const tag = () => "world";`);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();

    // Every module in the chain emits real, non-empty JS (the bug left app.js empty).
    expect((await readText(cache, "/~/main.js")).length).toBeGreaterThan(0);
    expect((await readText(cache, "/~/app.js")).length).toBeGreaterThan(0);
    expect((await readText(cache, "/~/store.js")).length).toBeGreaterThan(0);
    // And app.js carries app.ts's real body (its import of store, rewritten).
    const appJs = await readText(cache, "/~/app.js");
    expect(appJs).toContain("hello");
    expect(appJs).toContain("store.js");
  });

  it("handles a .tsx entry imported via ./x.js from another entry", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import { A } from "./widget.js";\nexport const x = A;`);
    await writeText(project, "/widget.tsx", `export const A = () => "widget";`);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();

    expect((await readText(cache, "/~/widget.js")).length).toBeGreaterThan(0);
    expect(await readText(cache, "/~/widget.js")).toContain("widget");
  });
});
