import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

describe("newProjectBuild — CSS/JSON emit form", () => {
  it("emits json → serveJsonModule .js and css-from-JS → cssModuleWrapper .js, importer rewritten", async () => {
    const project = new MemFilesApi();
    await writeText(
      project,
      "/main.tsx",
      `import data from "./data.json";\nimport "./styles.css";\nexport const x: unknown = data;`,
    );
    await writeText(project, "/data.json", `{"a":1,"b":"two"}`);
    await writeText(project, "/styles.css", `.foo { color: red; }`);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();

    // JSON → `serveJsonModule` export-default wrap at the ext-mapped `.js`.
    expect(await cache.exists("/~/data.js")).toBe(true);
    const dataJs = await readText(cache, "/~/data.js");
    expect(dataJs).toContain("export default");
    expect(dataJs).toContain(`"a":1`);
    expect(dataJs).toContain(`"b":"two"`);

    // CSS imported from JS → `cssModuleWrapper` injector `.js` (not raw CSS).
    expect(await cache.exists("/~/styles.js")).toBe(true);
    const stylesJs = await readText(cache, "/~/styles.js");
    expect(stylesJs).toContain(`document.createElement("style")`);
    expect(stylesJs).toContain("export default");
    // The processed CSS text is embedded, not left as a bare stylesheet body.
    expect(stylesJs).toContain("color");

    // Importer specifiers rewritten to the emitted `.js` forms.
    const mainJs = await readText(cache, "/~/main.js");
    expect(mainJs).toContain(`from "./data.js"`);
    expect(mainJs).toContain(`"./styles.js"`);
    expect(mainJs).not.toContain(`.json"`);
    expect(mainJs).not.toContain(`.css"`);
  });
});
