/**
 * Tests for path utility functions
 */

import { describe, expect, it } from "vitest";
import {
  basename,
  dirname,
  extname,
  joinPath,
  normalizePath,
  resolveFileRef,
  toPath,
} from "../src/index.js";

describe("Path utilities", () => {
  describe("normalizePath()", () => {
    it("should add leading slash", () => {
      expect(normalizePath("foo/bar")).toBe("/foo/bar");
    });

    it("should remove trailing slash", () => {
      expect(normalizePath("/foo/bar/")).toBe("/foo/bar");
    });

    it("should collapse double slashes", () => {
      expect(normalizePath("//foo//bar//")).toBe("/foo/bar");
    });

    it("should handle empty string", () => {
      expect(normalizePath("")).toBe("/");
    });

    it("should handle root", () => {
      expect(normalizePath("/")).toBe("/");
    });

    it("should remove dot segments", () => {
      expect(normalizePath("/foo/./bar")).toBe("/foo/bar");
      expect(normalizePath("./foo")).toBe("/foo");
    });

    it("should handle multiple consecutive slashes", () => {
      expect(normalizePath("///a///b///c///")).toBe("/a/b/c");
    });

    it("should handle single segment", () => {
      expect(normalizePath("file.txt")).toBe("/file.txt");
    });
  });

  describe("toPath()", () => {
    it("should return string as-is", () => {
      expect(toPath("/foo/bar")).toBe("/foo/bar");
    });

    it("should extract path from object", () => {
      expect(toPath({ path: "/foo/bar" })).toBe("/foo/bar");
    });
  });

  describe("resolveFileRef()", () => {
    it("should handle string path", () => {
      expect(resolveFileRef("foo/bar")).toBe("/foo/bar");
    });

    it("should handle object with path", () => {
      expect(resolveFileRef({ path: "foo/bar" })).toBe("/foo/bar");
    });

    it("should normalize the path", () => {
      expect(resolveFileRef("//foo//bar//")).toBe("/foo/bar");
    });
  });

  describe("joinPath()", () => {
    it("should join segments", () => {
      expect(joinPath("/foo", "bar", "baz")).toBe("/foo/bar/baz");
    });

    it("should handle leading slashes in segments", () => {
      expect(joinPath("/foo", "/bar")).toBe("/foo/bar");
    });

    it("should handle empty segments", () => {
      expect(joinPath("/foo", "", "bar")).toBe("/foo/bar");
    });

    it("should handle single segment", () => {
      expect(joinPath("foo")).toBe("/foo");
    });

    it("should handle multiple segments with mixed slashes", () => {
      expect(joinPath("/a/", "/b/", "/c/")).toBe("/a/b/c");
    });
  });

  describe("dirname()", () => {
    it("should return parent directory", () => {
      expect(dirname("/foo/bar/file.txt")).toBe("/foo/bar");
    });

    it("should return root for top-level file", () => {
      expect(dirname("/file.txt")).toBe("/");
    });

    it("should handle root", () => {
      expect(dirname("/")).toBe("/");
    });

    it("should handle nested directories", () => {
      expect(dirname("/a/b/c/d")).toBe("/a/b/c");
    });
  });

  describe("basename()", () => {
    it("should return filename", () => {
      expect(basename("/foo/bar/file.txt")).toBe("file.txt");
    });

    it("should strip extension if provided", () => {
      expect(basename("/foo/file.txt", ".txt")).toBe("file");
    });

    it("should handle no extension match", () => {
      expect(basename("/foo/file.txt", ".md")).toBe("file.txt");
    });

    it("should handle no directory", () => {
      expect(basename("file.txt")).toBe("file.txt");
    });

    it("should handle root", () => {
      expect(basename("/")).toBe("");
    });
  });

  describe("extname()", () => {
    it("should return extension with dot", () => {
      expect(extname("/foo/file.txt")).toBe(".txt");
    });

    it("should handle multiple dots", () => {
      expect(extname("/foo/file.test.ts")).toBe(".ts");
    });

    it("should return empty for no extension", () => {
      expect(extname("/foo/file")).toBe("");
    });

    it("should return empty for dotfiles", () => {
      expect(extname("/foo/.gitignore")).toBe("");
    });

    it("should handle complex extensions", () => {
      expect(extname("/foo/archive.tar.gz")).toBe(".gz");
    });
  });
});
