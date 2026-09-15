/**
 * Byte-level conformance with the SQLite Archive format, checked with raw SQL
 * against the table rather than through the adapter.
 */
import { describe, expect, it } from "vitest";
import { newArchive } from "./helpers.js";

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
