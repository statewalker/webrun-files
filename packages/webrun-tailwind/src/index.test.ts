import type { PreprocessContext } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { generateTailwindCss, TAILWIND_VERSION, tailwindCacheKey } from "./index.js";

// A source with no project `@import` never touches ctx.files, so a bare ctx suffices.
const noCtx = {} as PreprocessContext;

describe("generateTailwindCss", () => {
  it("emits the all-classes stylesheet (legacy @tailwind source → import prepended)", async () => {
    const css = await generateTailwindCss(
      "@tailwind base;\n@tailwind utilities;",
      noCtx,
      "~/s.css",
    );
    expect(css).toMatch(/\.flex\b/);
    expect(css).toMatch(/\.p-4\b/); // full set, not the partial one a bare @tailwind entry yields
  });

  it("honors the entry's own @theme customizations (custom tokens → real utilities)", async () => {
    const css = await generateTailwindCss(
      '@import "tailwindcss";\n@theme { --color-brand: #123456; }',
      noCtx,
      "~/s.css",
    );
    expect(css).toMatch(/\.bg-brand\b/); // a utility derived from the custom token exists
    expect(css).toContain("#123456"); // and carries the project's value, not a default
  });
});

describe("tailwindCacheKey", () => {
  it("returns the pinned version, independent of the source bytes", () => {
    expect(tailwindCacheKey("a")).toBe(TAILWIND_VERSION);
    expect(tailwindCacheKey("b")).toBe(TAILWIND_VERSION);
  });
});
