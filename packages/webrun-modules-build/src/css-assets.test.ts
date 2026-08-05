import { readText, writeText } from "@statewalker/webrun-files";
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
