/**
 * Byte-level conformance with the SQLite Archive format, checked with raw SQL
 * against the table rather than through the adapter.
 */
import { describe, expect, it } from "vitest";
import { newArchive, rawNames, rawRow } from "./helpers.js";

describe("SQLAR table", () => {
  it("declares exactly the five specified columns, in order, with the specified types", async () => {
    const { db } = await newArchive();
    const cols = db.prepare("PRAGMA table_info(sqlar)").all() as { name: string; type: string }[];
    expect(cols.map((c) => [c.name, c.type])).toEqual([
      ["name", "TEXT"],
      ["mode", "INT"],
      ["mtime", "INT"],
      ["sz", "INT"],
      ["data", "BLOB"],
    ]);
  });

  it("makes name the only primary key column", async () => {
    const { db } = await newArchive();
    const cols = db.prepare("PRAGMA table_info(sqlar)").all() as { name: string; pk: number }[];
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["name"]);
  });

  it("adds no other tables or indexes", async () => {
    const { db } = await newArchive();
    const objects = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    expect(objects.map((o) => o.name)).toEqual(["sqlar"]);
  });

  it("is idempotent and keeps existing rows", async () => {
    const { db, files } = await newArchive();
    db.prepare("INSERT INTO sqlar VALUES ('a.txt', 33188, 1, 1, x'41')").run();
    await files.init();
    expect(db.prepare("SELECT count(*) AS n FROM sqlar").get()).toEqual({ n: 1 });
  });
});

const enc = new TextEncoder();
const S_IFMT = 0o170000;

describe("SQLAR rows — files", () => {
  it("stores the name without its leading slash, as SQLAR tools do", async () => {
    const { db, files } = await newArchive();
    await files.write("/pkg/a.txt", [enc.encode("hi")]);
    expect(rawNames(db)).toEqual(["pkg", "pkg/a.txt"]);
  });

  it("stores short content as plaintext, with sz equal to length(data)", async () => {
    const { db, files } = await newArchive();
    await files.write("/a.txt", [enc.encode("hello")]);
    const row = rawRow(db, "a.txt");
    expect(row?.dtype).toBe("blob");
    expect(row?.sz).toBe(5);
    expect(row?.len).toBe(5);
    expect(new TextDecoder().decode(row?.data as Uint8Array)).toBe("hello");
  });

  it("gives a file the regular-file mode", async () => {
    const { db, files } = await newArchive();
    await files.write("/a.txt", [enc.encode("x")]);
    expect(rawRow(db, "a.txt")?.mode).toBe(0o100644);
  });

  it("stores mtime in seconds, not milliseconds", async () => {
    const { db, files } = await newArchive();
    const before = Math.floor(Date.now() / 1000);
    await files.write("/a.txt", [enc.encode("x")]);
    const after = Math.floor(Date.now() / 1000);
    const mtime = rawRow(db, "a.txt")?.mtime ?? 0;
    expect(mtime).toBeGreaterThanOrEqual(before);
    expect(mtime).toBeLessThanOrEqual(after);
  });

  it("stores an empty file as sz=0 with a zero-length blob, never NULL", async () => {
    const { db, files } = await newArchive();
    await files.write("/empty.bin", [new Uint8Array(0)]);
    const row = rawRow(db, "empty.bin");
    expect(row?.sz).toBe(0);
    expect(row?.dtype).toBe("blob");
    expect(row?.len).toBe(0);
  });

  it("replaces the row on overwrite", async () => {
    const { db, files } = await newArchive();
    await files.write("/a.txt", [enc.encode("first")]);
    await files.write("/a.txt", [enc.encode("2nd")]);
    expect(rawRow(db, "a.txt")?.sz).toBe(3);
    expect(rawNames(db)).toEqual(["a.txt"]);
  });
});

describe("SQLAR rows — directories", () => {
  it("stores a directory as sz=0 with data IS NULL and the directory mode", async () => {
    const { db, files } = await newArchive();
    await files.mkdir("/pkg");
    const row = rawRow(db, "pkg");
    expect(row?.sz).toBe(0);
    expect(row?.dtype).toBe("null");
    expect((row?.mode ?? 0) & S_IFMT).toBe(0o040000);
    expect(row?.mode).toBe(0o040755);
  });

  it("writes a row for every missing ancestor", async () => {
    const { db, files } = await newArchive();
    await files.mkdir("/a/b/c");
    expect(rawNames(db)).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("writes no row for the root", async () => {
    const { db, files } = await newArchive();
    await files.mkdir("/");
    await files.write("/top.txt", [enc.encode("x")]);
    expect(rawNames(db)).toEqual(["top.txt"]);
  });

  it("leaves an existing row alone", async () => {
    const { db, files } = await newArchive();
    await files.write("/a", [enc.encode("x")]);
    await files.mkdir("/a");
    expect(rawRow(db, "a")?.dtype).toBe("blob");
  });
});
