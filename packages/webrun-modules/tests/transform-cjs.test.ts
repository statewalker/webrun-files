import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { newCjsTransform } from "../src/transform/transform-cjs.js";
import type { SourceFile } from "../src/types.js";

const t = newCjsTransform();
// Rewrite maps relative specifiers to sibling .mjs files so the output is importable.
const rw = (s: string) => (s.startsWith(".") ? `${s}.mjs` : s);

const dirs: string[] = [];
afterAll(() => {}); // temp dirs auto-cleaned by the OS; kept for symmetry

async function build(files: Record<string, SourceFile>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cjs-spike-"));
  dirs.push(dir);
  for (const [name, file] of Object.entries(files)) {
    await writeFile(join(dir, name), await t.transform(file, rw));
  }
  return dir;
}

describe("newCjsTransform (executed)", () => {
  it("runs module.exports=fn, transitive require, and named exports", async () => {
    const dir = await build({
      "leaf.mjs": {
        path: "leaf.js",
        format: "cjs",
        source: `exports.double = (x) => x * 2;\nmodule.exports.tag = "leaf";`,
      },
      "main.mjs": {
        path: "main.js",
        format: "cjs",
        source: `const leaf = require("./leaf");\nmodule.exports = function (x) { return leaf.double(x); };\nmodule.exports.leafTag = leaf.tag;`,
      },
    });
    const mod = await import(pathToFileURL(join(dir, "main.mjs")).href);
    expect(typeof mod.default).toBe("function");
    expect(mod.default(21)).toBe(42); // transitive require("./leaf").double worked
    expect(mod.default.leafTag).toBe("leaf");

    const leaf = await import(pathToFileURL(join(dir, "leaf.mjs")).href);
    expect(leaf.double(5)).toBe(10); // named export snapshot importable
    expect(leaf.tag).toBe("leaf");
  });

  it("surfaces named exports through a `module.exports = require(...)` reexport", async () => {
    // React's entry (`module.exports = require('./cjs/react.development.js')`) is
    // this shape: the entry has no own exports, only a reexport. The interop must
    // follow it so `import { StrictMode } from "react"` resolves.
    const dir = await build({
      "impl.mjs": {
        path: "impl.js",
        format: "cjs",
        source: `exports.alpha = 1;\nexports.beta = 2;`,
      },
      "reexporter.mjs": {
        path: "reexporter.js",
        format: "cjs",
        source: `module.exports = require("./impl");`,
      },
    });
    const mod = await import(pathToFileURL(join(dir, "reexporter.mjs")).href);
    expect(mod.alpha).toBe(1); // named export surfaced via the reexport
    expect(mod.beta).toBe(2);
    expect(mod.default).toEqual({ alpha: 1, beta: 2 }); // default still the object
  });

  it("throws on a computed require at execution time", async () => {
    const dir = await build({
      "bad.mjs": {
        path: "bad.js",
        format: "cjs",
        source: `const n = "x";\nmodule.exports = require("./" + n);`,
      },
    });
    await expect(import(pathToFileURL(join(dir, "bad.mjs")).href)).rejects.toThrow(
      /Cannot require \(computed\/unresolved\)/,
    );
  });
});
