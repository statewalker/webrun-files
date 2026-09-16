import type { SqlDriver } from "./sql.types.js";

/** The subset of node:sqlite's `DatabaseSync` this driver uses. */
export interface NodeSqliteDatabase {
  prepare(sql: string): {
    all(...params: never[]): unknown[];
    run(...params: never[]): unknown;
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
}

/** The subset of a Durable Object's `ctx.storage.sql` this driver uses. */
export interface DoSqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Durable Object SQLite storage. Synchronous; BLOBs come back as ArrayBuffer. */
export class DoSqlDriver implements SqlDriver {
  readonly #sql: DoSqlStorage;

  constructor(sql: DoSqlStorage) {
    this.#sql = sql;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#sql.exec(sql, ...params).toArray() as T[];
  }

  run(sql: string, ...params: unknown[]): void {
    // The cursor is lazy; draining it makes sure the statement has run.
    this.#sql.exec(sql, ...params).toArray();
  }
}

/** The subset of a `D1Database` this driver uses. */
export interface D1Database {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results: unknown[] }>;
      run(): Promise<unknown>;
    };
  };
}

/** Cloudflare D1. Asynchronous; BLOBs come back as number[]. */
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
}
