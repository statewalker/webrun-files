import { readText, writeText } from "@statewalker/webrun-files";
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
 *  the scanner sees a distinct mtime after an edit/touch. */
const tick = () => new Promise((r) => setTimeout(r, 5));

async function seed() {
  const project = new MemFilesApi();
  await writeText(project, "/main.tsx", `import { u } from "./util.ts";\nexport const x = u;`);
  await writeText(project, "/util.ts", `export const u = "one";`);
  return project;
}

describe("newProjectBuild — incremental + prune", () => {
  it("(a) editing one source re-emits only its chain, not its importers", async () => {
    const project = await seed();
    const cache = new MemFilesApi();
    const transform = spyTransform();
    const build = newProjectBuild({ project, cache, transform });

    await build.build();
    expect(transform.paths).toContain("/main.tsx");
    expect(transform.paths).toContain("/util.ts");

    transform.paths.length = 0; // reset — measure the incremental delta only
    await tick();
    await writeText(project, "/util.ts", `export const u = "two";`); // edit the leaf
    await build.build();

    // Only util re-transforms; main is NOT re-linked (ext-map naming is content-
    // independent, so its emitted specifier `./util.js` is unchanged).
    expect(transform.paths).toContain("/util.ts");
    expect(transform.paths).not.toContain("/main.tsx");
    expect(await readText(cache, "/~/util.js")).toContain("two");
  });

  it("(b) a content-identical mtime touch reuses the artifact (no re-transform)", async () => {
    const project = await seed();
    const cache = new MemFilesApi();
    const transform = spyTransform();
    const build = newProjectBuild({ project, cache, transform });

    await build.build();
    transform.paths.length = 0;
    await tick();
    await writeText(project, "/util.ts", `export const u = "one";`); // same bytes, new mtime
    await build.build();

    // Scanner re-surfaces util on the mtime bump, but the hash gate reuses the
    // artifact — no transform runs.
    expect(transform.paths).not.toContain("/util.ts");
    expect(transform.paths).not.toContain("/main.tsx");
  });

  it("(c) deleting a source prunes its emitted artifact + hash sidecar", async () => {
    const project = await seed();
    await writeText(project, "/orphan.ts", `export const y = 1;`);
    const cache = new MemFilesApi();
    const build = newProjectBuild({ project, cache });

    await build.build();
    expect(await cache.exists("/~/orphan.js")).toBe(true);
    expect(await cache.exists("/~/orphan.js.hash")).toBe(true);

    await tick();
    await project.remove("/orphan.ts");
    await build.build();

    expect(await cache.exists("/~/orphan.js")).toBe(false);
    expect(await cache.exists("/~/orphan.js.hash")).toBe(false);
  });
});
