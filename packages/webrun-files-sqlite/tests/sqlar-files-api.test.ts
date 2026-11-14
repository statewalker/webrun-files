/**
 * FilesApi behaviour that the shared suite cannot know about: what follows
 * from SQLAR being a flat, case-sensitive keyspace with seconds for mtime.
 */
import type { Db } from "@statewalker/db-api";
import { collectGenerator, collectStream } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { SqlarFilesApi } from "../src/index.js";
import { type Spy, spyDb } from "./blocks/helpers.js";
import { newArchive, rawNames, rawRow } from "./helpers.js";
import { DRIVERS } from "./open-db.js";

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
    const put = "INSERT INTO sqlar VALUES (?, 33188, 1700000000, ?, ?)";
    await db.query(put, ["docs/guide/intro.md", 2, enc.encode("hi")]);
    await db.query(put, ["docs/readme.md", 3, enc.encode("abc")]);
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
    await db.query("UPDATE sqlar SET mtime = 1600000000 WHERE name = 'a.txt'");
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
    await db.query("UPDATE sqlar SET mtime = 1, mode = 33152 WHERE name = 'src.txt'");
    await files.copy("/src.txt", "/dst/copy.txt");
    const row = await rawRow(db, "dst/copy.txt");
    expect(row?.mode).toBe(33152);
    expect(row?.sz).toBe(7);
    expect(row?.mtime).toBeGreaterThan(1);
    expect((await rawRow(db, "dst"))?.dtype).toBe("null");
  });

  it("returns false for a missing source", async () => {
    const { files } = await newArchive();
    expect(await files.copy("/nope", "/x")).toBe(false);
    expect(await files.move("/nope", "/x")).toBe(false);
  });
});

describe("createExclusive", () => {
  it("returns false for a symlink, even a dangling one", async () => {
    const { files } = await newArchive();
    await files.symlink("/dangling.lock", "./missing");
    expect(await files.createExclusive("/dangling.lock", [enc.encode("x")])).toBe(false);
    expect(await files.readlink("/dangling.lock")).toBe("./missing");
    expect(await files.exists("/missing")).toBe(false);
  });

  it("returns false for a name that only exists as a prefix of others", async () => {
    const { db, files } = await newArchive();
    // A directory with no row of its own, as other SQLAR tools may write it.
    await files.write("/implicit/child.txt", [enc.encode("c")]);
    await db.query("DELETE FROM sqlar WHERE name = 'implicit'");
    expect(await files.createExclusive("/implicit", [enc.encode("x")])).toBe(false);
    expect(await rawRow(db, "implicit")).toBeUndefined();
  });

  it("stores the content as write does, compressed when shorter", async () => {
    const { db, files } = await newArchive();
    const text = "abc".repeat(1000);
    expect(await files.createExclusive("/big.lock", [enc.encode(text)])).toBe(true);
    const row = await rawRow(db, "big.lock");
    expect(row?.sz).toBe(3000);
    expect(row?.mode).toBe(0o100644);
    expect(row?.len).toBeLessThan(3000);
    expect(dec.decode(await collectStream(files.read("/big.lock")))).toBe(text);
  });
});

describe("move is one transaction", () => {
  /** Every row but mtime: what a reader can see. */
  async function contents(db: Db) {
    return db.query(
      "SELECT name, mode, sz, typeof(data) AS dtype, hex(data) AS data FROM sqlar ORDER BY name",
    );
  }

  /** An archive whose Db fails as `fail` says; `healthy` shares the Db and never fails. */
  async function failing(fail: Spy) {
    const { db, files: healthy } = await newArchive();
    const files = new SqlarFilesApi(spyDb(db, fail));
    return { db, files, healthy };
  }

  async function populate(files: SqlarFilesApi) {
    await files.write("/repo/index.lock", [enc.encode("new index ".repeat(50))]);
    await files.write("/repo/index", [enc.encode("old index")]);
    await files.write("/tree/a.txt", [enc.encode("a")]);
    await files.write("/tree/sub/b.txt", [enc.encode("b")]);
  }

  for (const driver of DRIVERS) {
    describe(`[${driver}]`, () => {
      it("a failure after its last statement leaves source and target unchanged", async () => {
        const { db, files: healthy } = await newArchive({ driver });
        let failures = 0;
        const files = new SqlarFilesApi(
          spyDb(db, {
            after: async (tx) => {
              failures++;
              await tx.query("SELECT * FROM no_such_table");
            },
          }),
        );
        await populate(healthy);
        const before = await contents(db);
        await expect(files.move("/repo/index.lock", "/repo/index")).rejects.toThrow(
          /no_such_table/,
        );
        await expect(files.move("/tree", "/new/place")).rejects.toThrow(/no_such_table/);
        expect(failures).toBe(2);
        expect(await contents(db)).toEqual(before);
        expect(dec.decode(await collectStream(healthy.read("/repo/index")))).toBe("old index");
      });
    });
  }

  it("a driver error on one of its statements leaves source and target unchanged", async () => {
    const { db, files, healthy } = await failing({
      query: async (sql, _params, next) => {
        if (/^\s*DELETE FROM sqlar/.test(sql)) throw new Error("disk I/O error");
        return next();
      },
    });
    await populate(healthy);
    const before = await contents(db);
    await expect(files.move("/repo/index.lock", "/repo/index")).rejects.toThrow("disk I/O error");
    expect(await contents(db)).toEqual(before);
  });

  it("renames rows instead of copying their content", async () => {
    const written: unknown[] = [];
    const { db, files, healthy } = await failing({
      query: async (sql, params, next) => {
        if (params.some((p) => p instanceof Uint8Array)) written.push(sql);
        return next();
      },
    });
    await populate(healthy);
    const stored = (await rawRow(db, "repo/index.lock"))?.data;
    expect(await files.move("/repo/index.lock", "/repo/index")).toBe(true);
    expect(await files.move("/tree", "/moved/tree")).toBe(true);
    expect(written).toEqual([]);
    expect((await rawRow(db, "repo/index"))?.data).toEqual(stored);
    expect(await rawRow(db, "repo/index.lock")).toBeUndefined();
    expect(await rawNames(db)).toEqual([
      "moved",
      "moved/tree",
      "moved/tree/a.txt",
      "moved/tree/sub",
      "moved/tree/sub/b.txt",
      "repo",
      "repo/index",
    ]);
  });

  it("replaces the target's subtree, as SqliteFilesApi does", async () => {
    const { db, files } = await newArchive();
    await files.write("/src/new.txt", [enc.encode("new")]);
    await files.write("/dst/old.txt", [enc.encode("old")]);
    await files.write("/f.txt", [enc.encode("file")]);
    expect(await files.move("/src", "/dst")).toBe(true);
    expect(await rawNames(db)).toEqual(["dst", "dst/new.txt", "f.txt"]);
    expect(await files.move("/f.txt", "/dst")).toBe(true);
    expect(await rawNames(db)).toEqual(["dst"]);
    expect(dec.decode(await collectStream(files.read("/dst")))).toBe("file");
  });

  it("refuses to move into the source's own subtree, or onto an ancestor", async () => {
    const { db, files } = await newArchive();
    await files.write("/a/b/c.txt", [enc.encode("c")]);
    const before = await rawNames(db);
    await expect(files.move("/a", "/a/b/inner")).rejects.toThrow(/contains/);
    await expect(files.move("/a/b", "/a")).rejects.toThrow(/contains/);
    expect(await rawNames(db)).toEqual(before);
    expect(dec.decode(await collectStream(files.read("/a/b/c.txt")))).toBe("c");
  });

  it("moves names outside the Basic Multilingual Plane", async () => {
    const { db, files } = await newArchive();
    await files.write("/\u{1F4C1}/\u{1F600}.txt", [enc.encode("smile")]);
    expect(await files.move("/\u{1F4C1}", "/d")).toBe(true);
    expect(await rawNames(db)).toEqual(["d", "d/\u{1F600}.txt"]);
  });
});
