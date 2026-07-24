import { describe, expect, it } from "vitest";
import { newEsmTransform } from "../src/transform/transform-esm.js";
import type { SourceFile } from "../src/types.js";

const t = newEsmTransform();
// Stub rewrite: makes each specifier visible and unambiguous in the output.
const rw = (s: string) => `/RW(${s})`;

describe("newEsmTransform", () => {
  it("strips TS types and rewrites the bare specifier in place (quotes kept)", async () => {
    const file: SourceFile = {
      path: "a.ts",
      format: "ts",
      source: `import { z } from "zod";\nconst x: number = z;\nexport default x;`,
    };
    const out = await t.transform(file, rw);
    expect(out).toContain(`from "/RW(zod)"`);
    expect(out).not.toContain(": number");
    expect(out).toContain("export default x");
  });

  it("rewrites relative, re-export, and dynamic-string specifiers; collects them all", async () => {
    const seen: string[] = [];
    const file: SourceFile = {
      path: "b.js",
      format: "esm",
      source: [
        `import a from "./a.js";`,
        `export { b } from "pkg/sub";`,
        `const m = await import("dyn-pkg");`,
        `console.log(a, m);`,
      ].join("\n"),
    };
    const out = await t.transform(file, (s) => {
      seen.push(s);
      return rw(s);
    });
    expect(seen.sort()).toEqual(["./a.js", "dyn-pkg", "pkg/sub"]);
    expect(out).toContain(`from "/RW(./a.js)"`);
    expect(out).toContain(`from "/RW(pkg/sub)"`);
    expect(out).toContain(`import("/RW(dyn-pkg)")`);
  });

  it("transpiles TSX (JSX + types) and rewrites the injected + explicit imports", async () => {
    const seen: string[] = [];
    const file: SourceFile = {
      path: "c.tsx",
      format: "tsx",
      source: `import { useState } from "react";\nexport function App(): JSX.Element {\n  const [n] = useState<number>(0);\n  return <h1>Hello {n}</h1>;\n}`,
    };
    const out = await t.transform(file, (s) => {
      seen.push(s);
      return rw(s);
    });
    expect(seen).toContain("react"); // explicit import
    expect(seen.some((s) => s.startsWith("react/jsx"))).toBe(true); // sucrase-injected JSX runtime
    expect(out).not.toContain("<h1>"); // JSX compiled away
    expect(out).not.toContain(": number"); // types stripped
    expect(out).toContain(`"/RW(react)"`);
  });

  it("leaves a computed dynamic specifier untouched", async () => {
    const file: SourceFile = {
      path: "c.js",
      format: "esm",
      source: `const n = "x"; export const p = import("./" + n + ".js");`,
    };
    const out = await t.transform(file, rw);
    expect(out).toContain(`import("./" + n + ".js")`);
    expect(out).not.toContain("RW(");
  });
});
