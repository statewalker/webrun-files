/** The transaction port, for every driver: all statements apply or none do. */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { D1SqlDriver, DoSqlDriver, NodeSqlDriver, type SqlDriver } from "../src/index.js";
import { fakeD1, fakeDoStorage } from "./fakes.js";

const drivers: [string, (db: DatabaseSync) => SqlDriver][] = [
  ["node:sqlite", (db) => new NodeSqlDriver(db)],
  ["Durable Object", (db) => new DoSqlDriver(fakeDoStorage(db))],
  ["D1", (db) => new D1SqlDriver(fakeD1(db))],
];

function table() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(k TEXT PRIMARY KEY, v INTEGER)");
  db.exec("CREATE INDEX t_v ON t(v)");
  db.exec("INSERT INTO t VALUES ('a', 1), ('b', 2)");
  return db;
}
const rows = (db: DatabaseSync) => db.prepare("SELECT k, v FROM t ORDER BY k").all();

for (const [label, driverFor] of drivers) {
  describe(`transaction — ${label}`, () => {
    it("applies every statement, in order", async () => {
      const db = table();
      await driverFor(db).transaction([
        { sql: "INSERT INTO t VALUES (?, ?)", params: ["c", 3] },
        { sql: "UPDATE t SET v = v * 10 WHERE k = ?", params: ["c"] },
        { sql: "DELETE FROM t WHERE k = 'a'" },
      ]);
      expect(rows(db)).toEqual([
        { k: "b", v: 2 },
        { k: "c", v: 30 },
      ]);
    });

    it("reports how many rows each statement changed, not counting index writes", async () => {
      const db = table();
      const counts = await driverFor(db).transaction([
        { sql: "UPDATE t SET v = 5 WHERE k = 'a'" },
        { sql: "UPDATE t SET v = 5 WHERE k = 'missing'" },
        { sql: "INSERT INTO t SELECT 'x', 9 WHERE EXISTS (SELECT 1 FROM t WHERE k = 'nope')" },
        { sql: "DELETE FROM t" },
      ]);
      expect(counts).toEqual([1, 0, 0, 2]);
    });

    it("rolls back every statement when a later one fails, and rethrows", async () => {
      const db = table();
      const driver = driverFor(db);
      await expect(
        (async () =>
          driver.transaction([
            { sql: "UPDATE t SET v = 100" },
            { sql: "DELETE FROM t WHERE k = 'b'" },
            { sql: "INSERT INTO t VALUES ('a', 0)" }, // UNIQUE violation
          ]))(),
      ).rejects.toThrow(/UNIQUE/);
      expect(rows(db)).toEqual([
        { k: "a", v: 1 },
        { k: "b", v: 2 },
      ]);
      expect(db.isTransaction).toBe(false);
      await driver.transaction([{ sql: "UPDATE t SET v = 7 WHERE k = 'a'" }]);
      expect(rows(db)[0]).toEqual({ k: "a", v: 7 });
    });

    it("accepts an empty statement list", async () => {
      const db = table();
      expect(await driverFor(db).transaction([])).toEqual([]);
    });
  });
}
