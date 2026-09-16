import type { SqlDriver, SqlStatement } from "./sql.types.js";

/** The subset of node:sqlite's `DatabaseSync` this driver uses. */
export interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: never[]): unknown[];
    run(...params: never[]): { changes: number | bigint };
  };
}

/** node:sqlite — local development, tests and any Node deployment. */
export class NodeSqlDriver implements SqlDriver {
  readonly #db: NodeSqliteDatabase;

  constructor(db: NodeSqliteDatabase) {
    this.#db = db;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#db.prepare(sql).all(...(params as never[])) as T[];
  }

  run(sql: string, ...params: unknown[]): void {
    this.#db.prepare(sql).run(...(params as never[]));
  }

  /** Synchronous from BEGIN to COMMIT, so no other call can interleave on the connection. */
  transaction(statements: SqlStatement[]): number[] {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const counts = statements.map(({ sql, params = [] }) =>
        Number(this.#db.prepare(sql).run(...(params as never[])).changes),
      );
      this.#db.exec("COMMIT");
      return counts;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** The subset of a Durable Object's `ctx.storage` this driver uses. */
export interface DoStorage {
  sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
  };
  transactionSync<T>(fn: () => T): T;
}

/**
 * Durable Object SQLite storage: pass `ctx.storage`. Synchronous; BLOBs come
 * back as ArrayBuffer. Transactions use `transactionSync`, since `sql.exec`
 * rejects `BEGIN`.
 */
export class DoSqlDriver implements SqlDriver {
  readonly #storage: DoStorage;

  constructor(storage: DoStorage) {
    this.#storage = storage;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#storage.sql.exec(sql, ...params).toArray() as T[];
  }

  run(sql: string, ...params: unknown[]): void {
    // The cursor is lazy; draining it makes sure the statement has run.
    this.#storage.sql.exec(sql, ...params).toArray();
  }

  /** `rowsWritten` also counts index rows, which keeps zero meaning "changed nothing". */
  transaction(statements: SqlStatement[]): number[] {
    return this.#storage.transactionSync(() =>
      statements.map(({ sql, params = [] }) => {
        const cursor = this.#storage.sql.exec(sql, ...params);
        cursor.toArray();
        return cursor.rowsWritten;
      }),
    );
  }
}

/** The subset of a `D1Database` this driver uses. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1BoundStatement[]): Promise<{ meta: { changes: number } }[]>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1BoundStatement;
}

interface D1BoundStatement {
  all(): Promise<{ results: unknown[] }>;
  run(): Promise<unknown>;
}

/** Cloudflare D1. Asynchronous; BLOBs come back as number[]; transactions are `batch()`. */
export class D1SqlDriver implements SqlDriver {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const { results } = await this.#db
      .prepare(sql)
      .bind(...params)
      .all();
    return results as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    await this.#db
      .prepare(sql)
      .bind(...params)
      .run();
  }

  async transaction(statements: SqlStatement[]): Promise<number[]> {
    if (statements.length === 0) return [];
    const results = await this.#db.batch(
      statements.map(({ sql, params = [] }) => this.#db.prepare(sql).bind(...params)),
    );
    return results.map((result) => result.meta.changes);
  }
}
