import type { PreprocessContext } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { makeExtMapPolicy } from "./url-policy.js";

// The policy reads only `ctx.depsPath` (through the core's `urlPath`); a partial
// ctx is all it needs.
const ctx = { depsPath: "" } as PreprocessContext;
const depsCtx = { depsPath: "deps/" } as PreprocessContext;

describe("makeExtMapPolicy", () => {
  const p = makeExtMapPolicy(ctx);

  it("ext-maps a JS-family sibling to ./a.js", () => {
    expect(p.servedUrl("~/a.tsx", "~/main.tsx")).toBe("./a.js");
    expect(p.servedUrl("~/a.ts", "~/main.tsx")).toBe("./a.js");
    expect(p.servedUrl("~/a.mjs", "~/main.tsx")).toBe("./a.js");
  });

  it("ext-maps json to .js", () => {
    expect(p.servedUrl("~/data.json", "~/main.tsx")).toBe("./data.js");
  });

  it("ext-maps css to .js (imported from JS → injector .js form)", () => {
    expect(p.servedUrl("~/styles.css", "~/main.tsx")).toBe("./styles.js");
  });

  it("never marks ?module on any form", () => {
    expect(p.servedUrl("~/data.json", "~/main.tsx")).not.toContain("?module");
    expect(p.servedUrl("~/styles.css", "~/main.tsx")).not.toContain("?module");
  });

  it("emittedPath ext-maps under /", () => {
    expect(p.emittedPath("~/main.tsx")).toBe("/~/main.js");
    expect(p.emittedPath("greet@1.0.0/index.js")).toBe("/greet@1.0.0/index.js");
  });

  it("a package dep resolves under the ctx depsPath prefix", () => {
    const pp = makeExtMapPolicy(depsCtx);
    expect(pp.emittedPath("greet@1.0.0/index.js")).toBe("/deps/greet@1.0.0/index.js");
    expect(pp.servedUrl("greet@1.0.0/index.js", "~/main.tsx")).toBe("../deps/greet@1.0.0/index.js");
  });
});
