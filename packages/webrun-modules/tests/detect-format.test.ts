import { describe, expect, it } from "vitest";
import { detectFormat } from "../src/transform/index.js";

describe("detectFormat", () => {
  it("uses the extension first", () => {
    expect(detectFormat("a.ts", "")).toBe("ts");
    expect(detectFormat("a.tsx", "")).toBe("tsx");
    expect(detectFormat("a.jsx", "")).toBe("tsx");
    expect(detectFormat("a.mjs", "require('x')")).toBe("esm");
    expect(detectFormat("a.cjs", "import x from 'y'")).toBe("cjs");
  });

  it("lets package.json#type decide ambiguous .js", () => {
    expect(detectFormat("a.js", "x", { name: "p", version: "1", type: "module" })).toBe("esm");
    expect(detectFormat("a.js", "x", { name: "p", version: "1", type: "commonjs" })).toBe("cjs");
  });

  it("sniffs .js content when type is absent", () => {
    expect(detectFormat("a.js", `const m = require("x");`)).toBe("cjs");
    expect(detectFormat("a.js", `module.exports = 1;`)).toBe("cjs");
    expect(detectFormat("a.js", `import x from "y"; export default x;`)).toBe("esm");
    expect(detectFormat("a.js", `console.log(1)`)).toBe("esm"); // default ESM
  });
});
