import { describe, expect, it } from "vitest";
import { analyze } from "../src/transform/analyze.js";

describe("analyze (esm/ts/tsx)", () => {
  it("collects named/default/namespace imports per specifier", async () => {
    const d = await analyze(
      [
        `import React, { useState } from "react";`,
        `import * as _ from "lodash-es";`,
        `export const x = 1;`,
        `export default function () {}`,
      ].join("\n"),
      "esm",
    );
    expect(d.imports.react).toEqual({ names: ["useState"], hasNamespace: false, hasDefault: true });
    expect(d.imports["lodash-es"]).toEqual({ names: [], hasNamespace: true, hasDefault: false });
    expect(d.exports.sort()).toEqual(["default", "x"]);
  });

  it("models free globals as imports[''] and ignores locally-declared names", async () => {
    const d = await analyze(`const Buffer = 1; console.log(process.env.NODE_ENV, Buffer);`, "esm");
    expect(d.imports[""].names).toContain("process");
    expect(d.imports[""].names).toContain("console");
    expect(d.imports[""].names).not.toContain("Buffer"); // locally declared
  });

  it("strips TS/JSX before parsing (tsx) and records the sucrase-injected jsx-runtime import", async () => {
    const d = await analyze(
      `import { useState } from "react";\nexport const App = () => <h1>{useState(0)}</h1>;`,
      "tsx",
    );
    expect(Object.keys(d.imports)).toContain("react");
    expect(Object.keys(d.imports).some((s) => s.startsWith("react/jsx"))).toBe(true);
  });

  it("captures re-export sources as imports", async () => {
    const d = await analyze(`export { b } from "pkg/sub";\nexport * from "other";`, "esm");
    expect(Object.keys(d.imports)).toEqual(expect.arrayContaining(["pkg/sub", "other"]));
    expect(d.exports).toContain("b");
  });
});
