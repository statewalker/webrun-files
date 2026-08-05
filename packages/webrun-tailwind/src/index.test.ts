import { describe, expect, it } from "vitest";
import { generateTailwindCss, TAILWIND_VERSION, tailwindCacheKey } from "./index.js";

describe("generateTailwindCss", () => {
  it("emits the generic all-classes stylesheet containing known utilities", async () => {
    const css = await generateTailwindCss("@tailwind base;\n@tailwind utilities;");
    expect(css).toMatch(/\.flex\b/);
    expect(css).toMatch(/\.p-4\b/);
  });
});

describe("tailwindCacheKey", () => {
  it("returns the pinned version, independent of the source bytes", () => {
    expect(tailwindCacheKey("a")).toBe(TAILWIND_VERSION);
    expect(tailwindCacheKey("b")).toBe(TAILWIND_VERSION);
  });
});
