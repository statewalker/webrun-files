import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toCts, writeCjsTypes } from "./cjs-types.mjs";

test("toCts rewrites relative .js specifiers to .cjs and keeps package specifiers", () => {
  const input = [
    'export * from "./types.js";',
    'export { a } from "../lib/a.js";',
    'import type { B } from "./b/index.js";',
    'import "./side.js";',
    'export type C = import("./c.js").C;',
    'import type { FilesApi } from "@statewalker/webrun-files";',
    'import type { X } from "some-lib/x.js";',
    "//# sourceMappingURL=index.d.ts.map",
  ].join("\n");
  assert.equal(
    toCts(input),
    [
      'export * from "./types.cjs";',
      'export { a } from "../lib/a.cjs";',
      'import type { B } from "./b/index.cjs";',
      'import "./side.cjs";',
      'export type C = import("./c.cjs").C;',
      'import type { FilesApi } from "@statewalker/webrun-files";',
      'import type { X } from "some-lib/x.js";',
      "",
    ].join("\n"),
  );
});

test("writeCjsTypes mirrors dist/**/*.d.ts into dist/cjs as .d.cts, skipping esm and cjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "cjs-types-"));
  try {
    const dist = join(dir, "dist");
    for (const sub of ["", "blocks", "esm", "cjs"]) mkdirSync(join(dist, sub), { recursive: true });
    writeFileSync(join(dist, "index.d.ts"), 'export * from "./blocks/codec.js";\n');
    writeFileSync(join(dist, "blocks", "codec.d.ts"), "export declare const codec: number;\n");
    writeFileSync(join(dist, "esm", "stray.d.ts"), "export {};\n");
    writeFileSync(join(dist, "cjs", "index.cjs"), "");

    assert.equal(writeCjsTypes(dir), 2);
    assert.equal(
      readFileSync(join(dist, "cjs", "index.d.cts"), "utf8"),
      'export * from "./blocks/codec.cjs";\n',
    );
    assert.equal(
      readFileSync(join(dist, "cjs", "blocks", "codec.d.cts"), "utf8"),
      "export declare const codec: number;\n",
    );
    assert.throws(() => readFileSync(join(dist, "cjs", "esm", "stray.d.cts")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCjsTypes fails when tsc emitted nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cjs-types-"));
  try {
    mkdirSync(join(dir, "dist", "cjs"), { recursive: true });
    assert.throws(() => writeCjsTypes(dir), /no declarations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
