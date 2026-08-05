import { describe, expect, it } from "vitest";
import { newCjsTransform } from "../src/transform/transform-cjs.js";

/**
 * React's package entry is a runtime `process.env.NODE_ENV` conditional:
 *   if (process.env.NODE_ENV === 'production') module.exports = require('./prod.js');
 *   else module.exports = require('./dev.js');
 * With no dead-code elimination the CJS transform static-imports BOTH branches, so
 * both react builds execute → two react instances → react-dom's shared-internals
 * (`ReactSharedInternals`) is undefined at render. Folding the conditional against
 * the known NODE_ENV leaves a single live require → one instance.
 */
const REACT_STYLE = `
if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/react.production.js');
} else {
  module.exports = require('./cjs/react.development.js');
}
`;

const run = (production: boolean) =>
  newCjsTransform(production).transform(
    { path: "/react@19/index.js", source: REACT_STYLE, format: "cjs" },
    (s) => s,
  );

describe("CJS transform — NODE_ENV dead-code elimination", () => {
  it("production: keeps only the production branch's require (dev branch eliminated)", async () => {
    const { code } = await run(true);
    expect(code).toContain("react.production.js");
    expect(code).not.toContain("react.development.js"); // dev instance never imported/executed
  });

  it("development: keeps only the development branch's require", async () => {
    const { code } = await run(false);
    expect(code).toContain("react.development.js");
    expect(code).not.toContain("react.production.js");
  });

  it("leaves a CJS file without the NODE_ENV conditional unchanged", async () => {
    const { code } = await newCjsTransform(true).transform(
      { path: "/x.js", source: `const a = require('./a.js');\nmodule.exports = a;`, format: "cjs" },
      (s) => s,
    );
    expect(code).toContain("./a.js");
  });
});
