/**
 * Fakes that wrap node:sqlite in the documented handle shapes of Durable
 * Object storage and D1 — including how each returns a BLOB: ArrayBuffer from
 * `ctx.storage.sql`, number[] from D1. They prove the drivers' translation and
 * the adapters' blob handling, not the runtimes.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

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
