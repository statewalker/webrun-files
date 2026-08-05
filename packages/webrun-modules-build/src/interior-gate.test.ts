import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newDefaultTransform, type Transform } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

/** A JS/TS transform that records the path of every file it transforms. */
function spyTransform(): Transform & { paths: string[] } {
  const real = newDefaultTransform();
  const paths: string[] = [];
  return {
    paths,
    transform(file, rewrite) {
      paths.push(file.path);
      return real.transform(file, rewrite);
    },
  };
}

/** MemFilesApi stamps `lastModified` with `Date.now()`; a couple of ms guarantees
 *  the scanner sees a distinct mtime after an edit. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("newProjectBuild — interior-node gating (F1)", () => {
  it("(a) editing a ROOT re-transforms only the root, not its unchanged import", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import { u } from "./util.ts";\nexport const x = u;`);
    await writeText(project, "/util.ts", `export const u = "one";`);
    const cache = new MemFilesApi();
    const transform = spyTransform();
    const build = newProjectBuild({ project, cache, transform });

    await build.build();
    transform.paths.length = 0; // measure the incremental delta only
    await tick();
    // Edit the ROOT importer; util.ts is byte-identical.
    await writeText(
      project,
      "/main.tsx",
      `import { u } from "./util.ts";\nexport const x = u + "!";`,
    );
    await build.build();

    // Only the root re-transforms; the unchanged interior import is gate-skipped.
    expect(transform.paths).toContain("/main.tsx");
    expect(transform.paths).not.toContain("/util.ts");
  });

  it("(b) a diamond transforms the shared node once per build, not once per path", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import "./a.ts";\nimport "./b.ts";`);
    await writeText(project, "/a.ts", `import "./shared.ts";\nexport const a = 1;`);
    await writeText(project, "/b.ts", `import "./shared.ts";\nexport const b = 2;`);
    await writeText(project, "/shared.ts", `export const s = 0;`);
    const cache = new MemFilesApi();
    const transform = spyTransform();

    await newProjectBuild({ project, cache, transform }).build();

    // Every project source is scanned and walked; without an interior gate the
    // shared node re-transforms once per walk (main/a/b/shared). Gated → exactly one.
    const sharedCount = transform.paths.filter((p) => p === "/shared.ts").length;
    expect(sharedCount).toBe(1);
  });
});
