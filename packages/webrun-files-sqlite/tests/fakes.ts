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

/**
 * `ctx.storage`: `sql.exec(query, ...bindings)` → a cursor with `toArray()` and
 * `rowsWritten`; BLOB → ArrayBuffer; `transactionSync(fn)` runs `fn`
 * synchronously and rolls back if it throws. `sql.exec` rejects transaction
 * statements, as the runtime does.
 */
export function fakeDoStorage(db: DatabaseSync) {
  const exec = (query: string, ...bindings: unknown[]) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) {
      throw new Error("sql.exec() cannot execute transaction statements");
    }
    const stmt = db.prepare(query);
    const params = toNodeParams(bindings);
    let rows: unknown[] = [];
    let rowsWritten = 0;
    if (stmt.columns().length > 0) {
      rows = stmt.all(...params);
      // RETURNING statements write as well; count what they returned.
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)) rowsWritten = rows.length;
    } else {
      rowsWritten = Number(stmt.run(...params).changes);
    }
    const out = mapBlobs(rows, (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    return { toArray: () => out, rowsWritten };
  };
  return {
    sql: { exec },
    transactionSync<T>(fn: () => T): T {
      if (db.isTransaction) throw new Error("fake: nested transactionSync");
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/**
 * D1: prepare(q).bind(...).all() → { results }, run(), and batch(statements) —
 * one atomic transaction returning a result with `meta.changes` per statement;
 * BLOB → number[]; async.
 */
export function fakeD1(db: DatabaseSync) {
  return {
    async batch(statements: { run(): Promise<{ meta: { changes: number } }> }[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
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
          const stmt = db.prepare(query);
          const changes =
            stmt.columns().length > 0
              ? stmt.all(...params).length
              : Number(stmt.run(...params).changes);
          return { success: true, results: [], meta: { changes } };
        },
      };
      return statement;
    },
  };
}
