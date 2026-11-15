import { describe, expect, it } from "vitest";
import { basename, dirname, joinPath, normalizePath } from "../src/path-utils.js";

describe("normalizePath", () => {
  it("adds the leading slash, drops empty, `.` and trailing segments", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("a/b")).toBe("/a/b");
    expect(normalizePath("//a//./b/")).toBe("/a/b");
  });

  it("resolves `..` segments that stay inside the root", () => {
    expect(normalizePath("/a/../b")).toBe("/b");
    expect(normalizePath("/a/b/../../c")).toBe("/c");
    expect(normalizePath("/a/b/..")).toBe("/a");
    expect(normalizePath("/a/..")).toBe("/");
    expect(normalizePath("a/./b/../c/")).toBe("/a/c");
  });

  it("throws, naming the path, when `..` climbs above the root", () => {
    for (const path of ["..", "/..", "/../x", "/a/../../x", "/a/b/../../../x/y"]) {
      expect(() => normalizePath(path)).toThrow(path);
    }
  });

  it("never returns a `..` segment", () => {
    expect(normalizePath("/a/b/../c/../../d").split("/")).not.toContain("..");
  });
});

describe("helpers built on normalizePath", () => {
  it("joinPath resolves `..` across its segments and refuses escapes", () => {
    expect(joinPath("/base", "../other")).toBe("/other");
    expect(joinPath("/base", "/a/../b")).toBe("/base/b");
    expect(() => joinPath("/base", "/../../x")).toThrow();
  });

  it("dirname and basename work on the resolved path", () => {
    expect(dirname("/a/b/../c.txt")).toBe("/a");
    expect(basename("/a/b/../c.txt")).toBe("c.txt");
    expect(() => dirname("/../x")).toThrow();
  });
});
