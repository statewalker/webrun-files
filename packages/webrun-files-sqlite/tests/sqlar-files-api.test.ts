/**
 * FilesApi behaviour that the shared suite cannot know about: what follows
 * from SQLAR being a flat, case-sensitive keyspace with seconds for mtime.
 */
import { collectGenerator, collectStream } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { newArchive, rawRow } from "./helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("names are case-sensitive", () => {
  it("does not list /A's children under /a", async () => {
    const { files } = await newArchive();
    await files.write("/a/lower.txt", [enc.encode("l")]);
    await files.write("/A/upper.txt", [enc.encode("u")]);
    const names = (await collectGenerator(files.list("/a", { recursive: true }))).map(
      (e) => e.path,
    );
    expect(names).toEqual(["/a/lower.txt"]);
  });

  it("does not remove /A's children with /a", async () => {
    const { files } = await newArchive();
    await files.write("/a/lower.txt", [enc.encode("l")]);
    await files.write("/A/upper.txt", [enc.encode("u")]);
    await files.remove("/a");
    expect(await files.exists("/A/upper.txt")).toBe(true);
  });

  it("does not treat /a as a directory because /A has children", async () => {
    const { files } = await newArchive();
    await files.write("/A/upper.txt", [enc.encode("u")]);
    expect(await files.exists("/a")).toBe(false);
  });
});

describe("prefix siblings", () => {
  it("does not confuse /ab with a child of /a", async () => {
    const { files } = await newArchive();
    await files.write("/a/x.txt", [enc.encode("x")]);
    await files.write("/ab/y.txt", [enc.encode("y")]);
    await files.write("/a.txt", [enc.encode("z")]);
    const paths = (await collectGenerator(files.list("/a", { recursive: true }))).map(
      (e) => e.path,
    );
    expect(paths).toEqual(["/a/x.txt"]);
    await files.remove("/a");
    expect(await files.exists("/ab/y.txt")).toBe(true);
    expect(await files.exists("/a.txt")).toBe(true);
  });
});

describe("archives without directory rows", () => {
  async function foreign() {
    const { db, files } = await newArchive();
    const put = db.prepare("INSERT INTO sqlar VALUES (?, 33188, 1700000000, ?, ?)");
    put.run("docs/guide/intro.md", 2, enc.encode("hi"));
    put.run("docs/readme.md", 3, enc.encode("abc"));
    return { db, files };
  }

  it("reports a prefix-only path as a directory", async () => {
    const { files } = await foreign();
    expect(await files.stats("/docs/guide")).toEqual({ kind: "directory" });
    expect(await files.exists("/docs")).toBe(true);
  });

  it("lists prefix-only directories, each once", async () => {
    const { files } = await foreign();
    expect(await collectGenerator(files.list("/"))).toEqual([
      { kind: "directory", name: "docs", path: "/docs" },
    ]);
    expect(await collectGenerator(files.list("/docs"))).toEqual([
      { kind: "directory", name: "guide", path: "/docs/guide" },
      {
        kind: "file",
        name: "readme.md",
        path: "/docs/readme.md",
        size: 3,
        lastModified: 1700000000000,
      },
    ]);
  });

  it("lists prefix-only directories recursively, each once, in name order", async () => {
    const { files } = await foreign();
    const paths = (await collectGenerator(files.list("/", { recursive: true }))).map((e) => e.path);
    expect(paths).toEqual(["/docs", "/docs/guide", "/docs/guide/intro.md", "/docs/readme.md"]);
  });

  it("removes and copies a prefix-only directory", async () => {
    const { files } = await foreign();
    expect(await files.copy("/docs", "/copy")).toBe(true);
    expect(dec.decode(await collectStream(files.read("/copy/guide/intro.md")))).toBe("hi");
    expect(await files.remove("/docs")).toBe(true);
    expect(await files.exists("/docs")).toBe(false);
  });
});

describe("the root", () => {
  it("is a directory in an empty archive", async () => {
    const { files } = await newArchive();
    expect(await files.stats("/")).toEqual({ kind: "directory" });
    expect(await files.exists("/")).toBe(true);
    expect(await collectGenerator(files.list("/"))).toEqual([]);
  });
});

describe("time", () => {
  it("reports lastModified as the stored seconds times 1000", async () => {
    const { db, files } = await newArchive();
    await files.write("/a.txt", [enc.encode("x")]);
    db.prepare("UPDATE sqlar SET mtime = 1600000000 WHERE name = 'a.txt'").run();
    expect(await files.stats("/a.txt")).toEqual({
      kind: "file",
      size: 1,
      lastModified: 1600000000000,
    });
  });
});

describe("read", () => {
  it("throws when the signal is already aborted", async () => {
    const { files } = await newArchive();
    await files.write("/a.txt", [enc.encode("x")]);
    const signal = AbortSignal.abort(new Error("stop"));
    await expect(collectStream(files.read("/a.txt", { signal }))).rejects.toThrow("stop");
  });
});

describe("copy", () => {
  it("copies stored rows verbatim, with a fresh mtime", async () => {
    const { db, files } = await newArchive();
    await files.write("/src.txt", [enc.encode("payload")]);
    db.prepare("UPDATE sqlar SET mtime = 1, mode = 33152 WHERE name = 'src.txt'").run();
    await files.copy("/src.txt", "/dst/copy.txt");
    const row = rawRow(db, "dst/copy.txt");
    expect(row?.mode).toBe(33152);
    expect(row?.sz).toBe(7);
    expect(row?.mtime).toBeGreaterThan(1);
    expect(rawRow(db, "dst")?.dtype).toBe("null");
  });

  it("returns false for a missing source", async () => {
    const { files } = await newArchive();
    expect(await files.copy("/nope", "/x")).toBe(false);
    expect(await files.move("/nope", "/x")).toBe(false);
  });
});
