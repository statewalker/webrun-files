import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  coarseBucket,
  detectInputType,
  newDefaultTransformRegistry,
} from "../src/index.js";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { CssTransform } from "../src/types.js";

async function project(files: Record<string, string>) {
  const p = new MemFilesApi();
  for (const [k, v] of Object.entries(files)) await p.write(k, [new TextEncoder().encode(v)]);
  return p;
}

describe("@tailwind CSS fallback (no-drift)", () => {
  it("classifies @tailwind CSS as tailwind-css but the default registry has no such entry", () => {
    const reg = newDefaultTransformRegistry();
    expect(detectInputType("/tw.css", "@tailwind base;")).toBe("tailwind-css");
    expect(detectInputType("/imp.css", `@import "tailwindcss";`)).toBe("tailwind-css");
    expect(detectInputType("/plain.css", ".x { color: red }")).toBe("css");
    expect(reg.has("tailwind-css")).toBe(false); // default registry does NOT register it
  });

  it("falls back to the exact same `css` entry a plain .css uses (byte-identical by construction)", () => {
    const reg = newDefaultTransformRegistry();
    const ty = detectInputType("/tw.css", "@tailwind base;");
    // The dispatch a plain .css takes vs. what @tailwind CSS falls back to are the
    // SAME registered entry — so the run function + its output are identical.
    const fallback = reg.get(coarseBucket(ty));
    expect(fallback).toBe(reg.get("css"));
    expect(fallback.outType).toBe("css");
  });

  it("serves @tailwind CSS through ctx.css.transform (not an error) with the source reaching the seam", async () => {
    const seen: string[] = [];
    const echo: CssTransform = {
      async transform(file) {
        seen.push(file.source);
        return { code: `/*OK*/${file.source}`, exports: {} };
      },
    };
    const p = await project({ "/tw.css": "@tailwind base;" });
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, css: echo });
    const res = await server.fetch(new Request("http://h/~/tw.css"));
    expect(res.status).toBe(200); // not a 404 from a missing/erroring transform
    expect(res.headers.get("content-type")).toBe("text/css");
    expect(await res.text()).toBe("/*OK*/@tailwind base;"); // went through the css transform seam
    expect(seen).toContain("@tailwind base;"); // the tailwind source reached ctx.css.transform
  });
});
