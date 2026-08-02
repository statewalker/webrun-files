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

  it("is not fooled by the word 'export' in a CJS file's strings (the React case)", () => {
    // module.exports/exports.x are impossible in real ESM → definitive CJS,
    // even though a dev-warning string contains " export ".
    const src = `'use strict';\nvar React = require('react');\nfunction warn(){ return "you forgot to export your component"; }\nexports.jsxDEV = function(){};`;
    const manifest = { name: "react", version: "18.3.1" }; // no "type" field
    expect(detectFormat("cjs/react-jsx-dev-runtime.development.js", src, manifest)).toBe("cjs");
  });

  it("defaults a package .js with no type to CJS (Node semantics), authored .js to ESM", () => {
    expect(detectFormat("lib/x.js", `doStuff();`, { name: "p", version: "1" })).toBe("cjs");
    expect(detectFormat("x.js", `doStuff();`)).toBe("esm"); // no manifest = authored source
  });
});
