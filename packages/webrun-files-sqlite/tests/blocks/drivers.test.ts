import { DatabaseSync } from "node:sqlite";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { D1SqlDriver, DoSqlDriver, type SqlDriver, SqliteFilesApi } from "../../src/index.js";
import { fakeD1, fakeDoStorage } from "../fakes.js";

const drivers: [string, (db: DatabaseSync) => SqlDriver][] = [
  ["Durable Object", (db) => new DoSqlDriver(fakeDoStorage(db))],
  ["D1", (db) => new D1SqlDriver(fakeD1(db))],
];

for (const [label, driverFor] of drivers) {
  createFilesApiTests(`SqliteFilesApi (${label} driver)`, async () => {
    const db = new DatabaseSync(":memory:");
    const files = new SqliteFilesApi(driverFor(db), { blockSize: 4096 });
    await files.init();
    return { api: files, cleanup: async () => db.close() };
  });
}
