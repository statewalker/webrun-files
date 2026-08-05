import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newDefaultTransform, type Transform } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

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

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("newProjectBuild — persistence across engine instances", () => {
  it("a fresh build over the same project+cache re-emits only the edited chain", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/main.tsx", `import { u } from "./util.ts";\nexport const x = u;`);
    await writeText(project, "/util.ts", `export const u = "one";`);
    const cache = new MemFilesApi();

    // First build with a throwaway engine — flushes watermarks (scanner mtimes,
    // transaction/update stores) into project/.project/state and hash sidecars
    // into cache.
    await newProjectBuild({ project, cache }).build();
    expect(await cache.exists("/~/main.js")).toBe(true);
    expect(await cache.exists("/~/util.js")).toBe(true);

    await tick();
    await writeText(project, "/util.ts", `export const u = "two";`); // edit the leaf

    // A brand-new engine + host over the SAME project + cache: it restores the
    // FileBacked watermarks + scanner mtimes from disk and the hash sidecars from
    // cache, so only util's changed chain re-transforms.
    const transform = spyTransform();
    await newProjectBuild({ project, cache, transform }).build();

    expect(transform.paths).toContain("/util.ts");
    expect(transform.paths).not.toContain("/main.tsx");
    expect(await readText(cache, "/~/util.js")).toContain("two");
  });
});
