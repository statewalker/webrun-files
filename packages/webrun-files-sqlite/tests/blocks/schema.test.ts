import type { Db } from "@statewalker/db-api";
import { describe, expect, it } from "vitest";
import { newFiles } from "./helpers.js";

const objects = async (db: Db) =>
  (
    await db.query<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
  ).map((o) => `${o.type}:${o.name}`);

describe("SqliteFilesApi schema", () => {
  it("creates the three tables and their indexes", async () => {
    const { db } = await newFiles();
    expect(await objects(db)).toEqual([
      "index:fs_files_hash",
      "index:fs_paths_fid",
      "table:fs_blocks",
      "table:fs_files",
      "table:fs_paths",
    ]);
  });

  it("keys blocks by (fid, shift)", async () => {
    const { db } = await newFiles();
    const cols = await db.query<{ name: string; pk: number }>("PRAGMA table_info(fs_blocks)");
    expect(cols.filter((c) => c.pk > 0).map((c) => [c.name, c.pk])).toEqual([
      ["fid", 1],
      ["shift", 2],
    ]);
  });

  it("makes path unique", async () => {
    const { db } = await newFiles();
    await db.query("INSERT INTO fs_paths(path, fid, mtime) VALUES ('/a', NULL, 1)");
    await expect(
      db.query("INSERT INTO fs_paths(path, fid, mtime) VALUES ('/a', NULL, 2)"),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("uses the table prefix", async () => {
    const { db } = await newFiles({ tablePrefix: "site_" });
    expect(await objects(db)).toEqual([
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
    expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM fs_paths"))[0].n).toBe(1);
  });
});
