/**
 * The Durable Object and D1 drivers, exercised through fakes that wrap
 * node:sqlite in each runtime's documented handle shape — including how each
 * returns a BLOB: ArrayBuffer from `ctx.storage.sql`, number[] from D1. This
 * proves the translation and the adapter's blob handling, not the runtimes.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { describe, expect, it } from "vitest";
import {
  D1SqlDriver,
  DoSqlDriver,
  pakoCodec,
  SqlarFilesApi,
  type SqlDriver,
} from "../src/index.js";

type Row = Record<string, unknown>;

function mapBlobs(rows: unknown[], map: (bytes: Uint8Array) => unknown): Row[] {
  return (rows as Row[]).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? map(v) : v]),
    ),
  );
}

/** Bindings arrive as runtime values; node:sqlite wants Uint8Array for blobs. */
function toNodeParams(params: unknown[]): SQLInputValue[] {
  return params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p)) as SQLInputValue[];
}

/** `ctx.storage.sql`: exec(query, ...bindings) → cursor with toArray(); BLOB → ArrayBuffer. */
export function fakeDoSql(db: DatabaseSync) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const params = toNodeParams(bindings);
      let rows: unknown[] = [];
      if (stmt.columns().length > 0) rows = stmt.all(...params);
      else stmt.run(...params);
      const out = mapBlobs(rows, (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      return { toArray: () => out };
    },
  };
}

/** D1: prepare(q).bind(...).all() → { results }, run(); BLOB → number[]; async. */
export function fakeD1(db: DatabaseSync) {
  return {
    prepare(query: string) {
      let params: SQLInputValue[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = toNodeParams(values);
          return statement;
        },
        async all() {
          const rows = db.prepare(query).all(...params);
          return { success: true, results: mapBlobs(rows, (b) => Array.from(b)) };
        },
        async run() {
          db.prepare(query).run(...params);
          return { success: true, results: [] };
        },
      };
      return statement;
    },
  };
}

const drivers: [string, (db: DatabaseSync) => SqlDriver][] = [
  ["Durable Object", (db) => new DoSqlDriver(fakeDoSql(db))],
  ["D1", (db) => new D1SqlDriver(fakeD1(db))],
];

for (const [label, driverFor] of drivers) {
  createFilesApiTests(`SqlarFilesApi (${label} driver)`, async () => {
    const db = new DatabaseSync(":memory:");
    const files = new SqlarFilesApi(driverFor(db));
    await files.init();
    return { api: files, cleanup: async () => db.close() };
  });

  describe(`${label} driver`, () => {
    it("reads compressed rows and link targets back through the runtime's value shapes", async () => {
      const db = new DatabaseSync(":memory:");
      const files = new SqlarFilesApi(driverFor(db), { codec: pakoCodec(pako) });
      await files.init();
      const big = new TextEncoder().encode("line\n".repeat(1000));
      await files.write("/big.txt", [big]);
      await files.symlink("/link", "big.txt");
      await files.copy("/big.txt", "/copy.txt");
      await files.copy("/link", "/link-copy");

      const read = async (p: string) => {
        const chunks: Uint8Array[] = [];
        for await (const c of files.read(p)) chunks.push(c);
        return chunks[0];
      };
      expect(await read("/link")).toEqual(big);
      expect(await read("/copy.txt")).toEqual(big);
      expect(await files.readlink("/link-copy")).toBe("big.txt");
      const stored = db
        .prepare("SELECT typeof(data) AS t, length(data) AS n FROM sqlar WHERE name = 'copy.txt'")
        .get() as { t: string; n: number };
      expect(stored.t).toBe("blob");
      expect(stored.n).toBeLessThan(big.byteLength);
    });
  });
}
