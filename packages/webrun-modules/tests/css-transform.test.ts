import { describe, expect, it } from "vitest";
import { newLightningCssTransform } from "../src/transform/css/lightning-css-transform.js";

const t = newLightningCssTransform();
const rw = (s: string) => `/RW(${s})`;

describe("newLightningCssTransform", () => {
  it("flattens nesting and rewrites url()/@import to same-origin", async () => {
    const out = await t.transform(
      {
        path: "a.css",
        cssModules: false,
        source: `@import "./base.css";\n.a { .b { color: red } background: url(./bg.png) }`,
      },
      rw,
    );
    expect(out.code).toContain("/RW(./base.css)");
    expect(out.code).toContain("/RW(./bg.png)");
    expect(out.code).toMatch(/\.a \.b/); // nesting flattened
  });

  it("returns a scoped class-name map for CSS Modules", async () => {
    const out = await t.transform(
      { path: "x.module.css", cssModules: true, source: `.title { font-weight: bold }` },
      rw,
    );
    expect(Object.keys(out.exports)).toContain("title");
    expect(out.code).toContain(out.exports.title); // the scoped name appears in the emitted CSS
    expect(out.exports.title).not.toBe("title"); // it was hashed/scoped
  });

  it("adds a vendor prefix using the default targets", async () => {
    const out = await t.transform(
      { path: "p.css", cssModules: false, source: `.a { user-select: none }` },
      rw,
    );
    expect(out.code).toMatch(/-webkit-user-select|-moz-user-select/);
  });
});
