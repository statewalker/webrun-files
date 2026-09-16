import { describe, expect, it } from "vitest";
import { newFiles } from "./helpers.js";

const objects = (db: import("node:sqlite").DatabaseSync) =>
  (
    db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string }[]
  ).map((o) => `${o.type}:${o.name}`);

describe("SqliteFilesApi schema", () => {
  it("creates the three tables and their indexes", async () => {
    const { db } = await newFiles();
    expect(objects(db)).toEqual([
      "index:fs_files_hash",
      "index:fs_paths_fid",
      "table:fs_blocks",
      "table:fs_files",
      "table:fs_paths",
    ]);
  });

  it("keys blocks by (fid, shift)", async () => {
    const { db } = await newFiles();
    const cols = db.prepare("PRAGMA table_info(fs_blocks)").all() as { name: string; pk: number }[];
    expect(cols.filter((c) => c.pk > 0).map((c) => [c.name, c.pk])).toEqual([
      ["fid", 1],
      ["shift", 2],
    ]);
  });

  it("makes path unique", async () => {
    const { db } = await newFiles();
    db.prepare("INSERT INTO fs_paths(path, fid, mtime) VALUES ('/a', NULL, 1)").run();
    expect(() =>
      db.prepare("INSERT INTO fs_paths(path, fid, mtime) VALUES ('/a', NULL, 2)").run(),
    ).toThrow(/UNIQUE/);
  });

  it("uses the table prefix", async () => {
    const { db } = await newFiles({ tablePrefix: "site_" });
    expect(objects(db)).toEqual([
      "index:site_files_hash",
      "index:site_paths_fid",
      "table:site_blocks",
      "table:site_files",
      "table:site_paths",
    ]);
  });

  it("rejects a prefix that is not a plain identifier", async () => {
    await expect(newFiles({ tablePrefix: "x; DROP TABLE y; --" })).rejects.toThrow(/tablePrefix/);
  });

  it("is idempotent", async () => {
    const { db, files } = await newFiles();
    await files.write("/a.txt", [new Uint8Array([1])]);
    await files.init();
    expect((db.prepare("SELECT count(*) AS n FROM fs_paths").get() as { n: number }).n).toBe(1);
  });
});
