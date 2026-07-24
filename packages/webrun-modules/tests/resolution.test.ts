import { describe, expect, it } from "vitest";
import {
  isNodeBuiltin,
  nodeBuiltinName,
  resolveNodeBuiltin,
} from "../src/resolution/node-builtins.js";
import { resolveEntry } from "../src/resolution/resolve-entry.js";
import type { PackageManifest } from "../src/types.js";

const mk = (m: Partial<PackageManifest>): PackageManifest => ({
  name: "p",
  version: "1.0.0",
  ...m,
});

describe("resolveEntry", () => {
  it("honors conditional exports per target", () => {
    const m = mk({ exports: { ".": { browser: "./b.js", node: "./n.js", default: "./d.js" } } });
    expect(resolveEntry(m, undefined, "browser")).toBe("b.js");
    expect(resolveEntry(m, undefined, "node")).toBe("n.js");
  });

  it("resolves subpath exports with patterns", () => {
    const m = mk({ exports: { ".": "./index.js", "./merge": "./lib/merge.js" } });
    expect(resolveEntry(m, "merge", "browser")).toBe("lib/merge.js");
  });

  it("falls back to a require-only exports map", () => {
    const m = mk({ exports: { ".": { require: "./cjs.js" } } });
    expect(resolveEntry(m, undefined, "node")).toBe("cjs.js");
  });

  it("uses legacy main/module/browser when no exports field", () => {
    expect(resolveEntry(mk({ main: "./main.js", module: "./esm.js" }), undefined, "browser")).toBe(
      "esm.js",
    );
    expect(resolveEntry(mk({ main: "./main.js" }), undefined, "node")).toBe("main.js");
    expect(
      resolveEntry(mk({ browser: "./browser.js", main: "./main.js" }), undefined, "browser"),
    ).toBe("browser.js");
  });

  it("treats a deep subpath as a direct file when unexported", () => {
    expect(resolveEntry(mk({ main: "./index.js" }), "lib/x.js", "browser")).toBe("lib/x.js");
  });

  it("throws for a root entry when exports omit `.` and there is no legacy main", () => {
    // e.g. @jspm/core: only `./nodelibs/*` is exported, `.` is not. Fabricating
    // `index.js` here would produce a dead URL; fail loudly instead.
    const m = mk({ name: "@jspm/core", exports: { "./nodelibs/*": "./nodelibs/browser/*.js" } });
    expect(() => resolveEntry(m, undefined, "browser")).toThrow(/no root entry/);
  });
});

describe("node builtins", () => {
  it("detects builtins with and without node: prefix and subpaths", () => {
    expect(isNodeBuiltin("path")).toBe(true);
    expect(isNodeBuiltin("node:path")).toBe(true);
    expect(nodeBuiltinName("node:fs/promises")).toBe("fs/promises");
    expect(isNodeBuiltin("zod")).toBe(false);
  });

  it("maps to @jspm/core polyfill under browser, external under node", () => {
    expect(resolveNodeBuiltin("node:path", "browser")).toEqual({
      ref: { pkg: "@jspm/core", subpath: "nodelibs/path" },
    });
    expect(resolveNodeBuiltin("path", "node")).toEqual({ external: "node:path" });
    expect(resolveNodeBuiltin("zod", "browser")).toBeUndefined();
  });

  it("subpath resolves via @jspm/core exports without doubling `browser`", () => {
    // `@jspm/core` maps `./nodelibs/*` → `default: ./nodelibs/browser/*.js`, so the
    // ref subpath must be `nodelibs/path` — `nodelibs/browser/path` would expand to
    // the nonexistent `nodelibs/browser/browser/path.js`.
    const jspm = mk({
      name: "@jspm/core",
      exports: {
        "./nodelibs/*": { node: "./nodelibs/node/*.js", default: "./nodelibs/browser/*.js" },
      },
    });
    const b = resolveNodeBuiltin("node:path", "browser") as { ref: { subpath: string } };
    expect(resolveEntry(jspm, b.ref.subpath, "browser")).toBe("nodelibs/browser/path.js");
  });
});
