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
      ref: { pkg: "@jspm/core", subpath: "nodelibs/browser/path" },
    });
    expect(resolveNodeBuiltin("path", "node")).toEqual({ external: "node:path" });
    expect(resolveNodeBuiltin("zod", "browser")).toBeUndefined();
  });
});
