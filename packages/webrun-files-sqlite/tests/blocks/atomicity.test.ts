/**
 * What an interruption can leave. Failures are injected inside the very
 * transaction under test (a statement violating NOT NULL is appended, so the
 * database itself rolls back), and a crash is a driver that stops answering.
 */
import { collectGenerator, collectStream, positionContent } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import {
  D1SqlDriver,
  DoSqlDriver,
  NodeSqlDriver,
  type SqlDriver,
  type SqlStatement,
} from "../../src/index.js";
import { fakeD1, fakeDoStorage } from "../fakes.js";
import { count, newFiles, passthrough, snapshot } from "./helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const DRIVERS: [string, (db: import("node:sqlite").DatabaseSync) => SqlDriver][] = [
  ["node:sqlite", (db) => new NodeSqlDriver(db)],
  ["Durable Object", (db) => new DoSqlDriver(fakeDoStorage(db))],
  ["D1", (db) => new D1SqlDriver(fakeD1(db))],
];
for (const [driverName, driver] of DRIVERS) {
  const small = { compression: null, blockSize: 64, driver } as const;

  describe(`[${driverName}]`, () => {
    const FAIL: SqlStatement = {
      sql: "INSERT INTO fs_paths(path, fid, mtime) VALUES (NULL, NULL, NULL)",
    };

    /** An API whose transactions containing `marker` fail after their last statement. */
    async function failingWhere(marker: string) {
      let failures = 0;
      const { db, files } = await newFiles({
        ...small,
        wrap: (d) =>
          passthrough(d, {
            transaction: (statements) => {
              if (!statements.some((s) => s.sql.includes(marker))) return d.transaction(statements);
              failures++;
              return d.transaction([...statements, FAIL]);
            },
          }),
      });
      const healthy = await newFiles({ ...small, db });
      return { db, files, healthy: healthy.files, failures: () => failures };
    }

    async function populate(files: Awaited<ReturnType<typeof newFiles>>["files"]) {
      await files.write("/src/a.txt", positionContent(200));
      await files.write("/src/sub/b.txt", [enc.encode("b")]);
      await files.write("/dst/old.txt", positionContent(150, [7], 1000));
    }

    describe("atomic steps roll back completely", () => {
      it("finishing a write: the path keeps its previous content and nothing is left over", async () => {
        // Fails where the path is pointed, after the content is finished and parents exist.
        const { db, files, healthy, failures } = await failingWhere("COALESCE");
        await populate(healthy);
        const before = snapshot(db);
        await expect(files.write("/dst/old.txt", positionContent(500, [64]))).rejects.toThrow(
          /NOT NULL/,
        );
        expect(failures()).toBe(1);
        expect(snapshot(db)).toEqual(before);
        expect((await collectStream(healthy.read("/dst/old.txt"))).length).toBe(150);
      });

      it("finishing a write to a new path in new folders: no path, no folder, no content", async () => {
        const { db, files, healthy } = await failingWhere("COALESCE");
        await populate(healthy);
        const before = snapshot(db);
        await expect(files.write("/new/deep/f.bin", positionContent(300))).rejects.toThrow(
          /NOT NULL/,
        );
        expect(snapshot(db)).toEqual(before);
      });

      it("remove", async () => {
        const { db, files, healthy, failures } = await failingWhere("DELETE FROM fs_paths");
        await populate(healthy);
        await healthy.copy("/src/a.txt", "/shared.txt");
        const before = snapshot(db);
        await expect(files.remove("/src")).rejects.toThrow(/NOT NULL/);
        expect(failures()).toBe(1);
        expect(snapshot(db)).toEqual(before);
      });

      it("copy onto an existing target keeps the target", async () => {
        const { db, files, healthy, failures } = await failingWhere(
          "INSERT INTO fs_paths(path, fid, mtime)\n",
        );
        await populate(healthy);
        const before = snapshot(db);
        await expect(files.copy("/src", "/dst")).rejects.toThrow(/NOT NULL/);
        expect(failures()).toBeGreaterThan(0);
        expect(snapshot(db)).toEqual(before);
        expect((await collectStream(healthy.read("/dst/old.txt"))).length).toBe(150);
      });

      it("move onto an existing target keeps both source and target", async () => {
        const { db, files, healthy, failures } = await failingWhere("UPDATE fs_paths");
        await populate(healthy);
        const before = snapshot(db);
        await expect(files.move("/src", "/dst")).rejects.toThrow(/NOT NULL/);
        expect(failures()).toBe(1);
        expect(snapshot(db)).toEqual(before);
      });
    });

    describe("a crash mid-stream", () => {
      it("leaves only an invisible pending content, which sweep removes with its blocks", async () => {
        let dead = false;
        const alive = <T>(fn: () => T): T => {
          if (dead) throw new Error("process died");
          return fn();
        };
        const { db, files } = await newFiles({
          ...small,
          wrap: (d) => ({
            all: (sql, ...params) => alive(() => d.all(sql, ...params)),
            run: (sql, ...params) => alive(() => d.run(sql, ...params)),
            transaction: (statements) => alive(() => d.transaction(statements)),
          }),
        });
        await files.write("/keep.txt", [enc.encode("keep")]);
        async function* source() {
          yield* positionContent(64 * 3, [64]);
          dead = true;
          yield* positionContent(64, [64]);
        }
        await expect(files.write("/crashed.bin", source())).rejects.toThrow("process died");

        const { files: restarted } = await newFiles({ ...small, db });
        expect((await collectGenerator(restarted.list("/"))).map((e) => e.path)).toEqual([
          "/keep.txt",
        ]);
        expect(count(db, "fs_files")).toBe(2);
        expect(count(db, "fs_blocks")).toBe(4);

        db.prepare("UPDATE fs_files SET updated = 0 WHERE size IS NULL").run();
        expect(await restarted.sweep({ olderThan: 60_000 })).toBe(1);
        expect(count(db, "fs_files")).toBe(1);
        expect(count(db, "fs_blocks")).toBe(1);
        expect(dec.decode(await collectStream(restarted.read("/keep.txt")))).toBe("keep");
      });

      it("a failing source cleans its pending content up without a sweep", async () => {
        const { db, files } = await newFiles(small);
        async function* broken() {
          yield* positionContent(200, [64]);
          throw new Error("source failed");
        }
        await expect(files.write("/f", broken())).rejects.toThrow("source failed");
        expect(count(db, "fs_files")).toBe(0);
        expect(count(db, "fs_blocks")).toBe(0);
      });
    });

    describe("a sweep racing a write that then crashes", () => {
      it("leaves no block without its content row, even when cleanup cannot run", async () => {
        const { db, files } = await newFiles({
          ...small,
          wrap: (d) =>
            passthrough(d, {
              transaction: (statements) => {
                if (
                  statements.some(
                    (st) => st.sql.includes("size IS NULL") && st.sql.startsWith("DELETE"),
                  )
                ) {
                  throw new Error("process died before cleanup");
                }
                return d.transaction(statements);
              },
            }),
        });
        async function* source() {
          yield* positionContent(64 * 2, [64]);
          db.prepare("UPDATE fs_files SET updated = 0 WHERE size IS NULL").run();
          await files.sweep({ olderThan: 60_000 });
          yield* positionContent(64 * 2, [64]);
        }
        await expect(files.write("/f", source())).rejects.toThrow(/swept during write/);
        expect(count(db, "fs_files")).toBe(0);
        expect(count(db, "fs_blocks")).toBe(0);
      });
    });

    describe("sweep", () => {
      async function withContents() {
        const { db, files } = await newFiles(small);
        await files.write("/referenced-old.txt", [enc.encode("r")]);
        const ins = db.prepare(
          "INSERT INTO fs_files(size, compression, block_size, hash, updated) VALUES (?, 'none', 64, ?, ?)",
        );
        const block = db.prepare("INSERT INTO fs_blocks(fid, shift, block) VALUES (?, 0, x'00')");
        const add = (size: number | null, updated: number) => {
          const { lastInsertRowid } = ins.run(size, size === null ? null : "h", updated);
          block.run(lastInsertRowid);
          return Number(lastInsertRowid);
        };
        db.prepare("UPDATE fs_files SET updated = 0").run();
        const now = Date.now();
        const ids = {
          pendingOld: add(null, now - 120_000),
          pendingYoung: add(null, now - 1_000),
          unreferencedOld: add(1, now - 120_000),
          unreferencedYoung: add(1, now - 1_000),
        };
        return { db, files, ids };
      }
      const fids = (db: Parameters<typeof count>[0]) =>
        (db.prepare("SELECT fid FROM fs_files ORDER BY fid").all() as { fid: number }[]).map(
          (r) => r.fid,
        );
      const blockFids = (db: Parameters<typeof count>[0]) =>
        (
          db.prepare("SELECT DISTINCT fid FROM fs_blocks ORDER BY fid").all() as { fid: number }[]
        ).map((r) => r.fid);

      it("removes pending and unreferenced contents older than the threshold, with their blocks", async () => {
        const { db, files, ids } = await withContents();
        expect(await files.sweep({ olderThan: 60_000 })).toBe(2);
        const kept = [1, ids.pendingYoung, ids.unreferencedYoung];
        expect(fids(db)).toEqual(kept);
        expect(blockFids(db)).toEqual(kept);
      });

      it("never removes a referenced content, however old", async () => {
        const { db, files } = await withContents();
        expect(await files.sweep({ olderThan: 0 })).toBe(4);
        expect(fids(db)).toEqual([1]);
        expect(dec.decode(await collectStream(files.read("/referenced-old.txt")))).toBe("r");
      });

      it("returns 0 when there is nothing to sweep", async () => {
        const { files } = await newFiles(small);
        expect(await files.sweep({ olderThan: 0 })).toBe(0);
      });

      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`rejects olderThan ${bad}`, async () => {
          const { files } = await newFiles(small);
          await expect(files.sweep({ olderThan: bad })).rejects.toThrow(/olderThan/);
        });
      }
    });

    describe("writes and sweeps racing", () => {
      const agePending = (db: Parameters<typeof count>[0]) =>
        db.prepare("UPDATE fs_files SET updated = 0 WHERE size IS NULL").run();

      it("a write whose pending content is swept between blocks throws, leaving no path or blocks", async () => {
        const { db, files } = await newFiles(small);
        async function* source() {
          yield* positionContent(64 * 2, [64]);
          agePending(db);
          await files.sweep({ olderThan: 60_000 });
          yield* positionContent(64 * 2, [64]);
        }
        await expect(files.write("/f", source())).rejects.toThrow(/\/f.*swept during write/);
        expect(await files.exists("/f")).toBe(false);
        expect(count(db, "fs_files")).toBe(0);
        expect(count(db, "fs_blocks")).toBe(0);
      });

      it("a write whose pending content is swept after its last block throws, leaving no path", async () => {
        const { db, files } = await newFiles(small);
        async function* source() {
          yield* positionContent(64 * 2, [64]);
          agePending(db);
          await files.sweep({ olderThan: 60_000 });
        }
        await expect(files.write("/f", source())).rejects.toThrow(/\/f.*swept during write/);
        expect(await files.exists("/f")).toBe(false);
        expect(count(db, "fs_paths")).toBe(0);
        expect(count(db, "fs_blocks")).toBe(0);
      });

      it("a write that keeps storing blocks is not swept", async () => {
        const { db, files } = await newFiles(small);
        async function* source() {
          yield* positionContent(64 * 2, [64]);
          agePending(db); // then another block is stored, which refreshes `updated`
          yield* positionContent(64, [64], 128);
          await files.sweep({ olderThan: 60_000 });
          yield* positionContent(64, [64], 192);
        }
        await files.write("/f", source());
        expect((await collectStream(files.read("/f"))).length).toBe(256);
      });
    });

    describe("a source that vanishes before copy or move", () => {
      for (const op of ["copy", "move"] as const) {
        it(`${op} returns false and leaves the target intact`, async () => {
          let armed = true;
          const { db, files } = await newFiles({
            ...small,
            wrap: (d) =>
              passthrough(d, {
                transaction: (statements) => {
                  if (armed) {
                    armed = false;
                    db.prepare(
                      "DELETE FROM fs_paths WHERE path = '/src' OR path LIKE '/src/%'",
                    ).run();
                  }
                  return d.transaction(statements);
                },
              }),
          });
          armed = false;
          await populate(files);
          armed = true;
          const target = snapshot(db).paths.filter((p) =>
            String((p as { path: string }).path).startsWith("/dst"),
          );
          expect(await files[op]("/src", "/dst")).toBe(false);
          expect(
            snapshot(db).paths.filter((p) =>
              String((p as { path: string }).path).startsWith("/dst"),
            ),
          ).toEqual(target);
        });
      }
    });
  });
}
