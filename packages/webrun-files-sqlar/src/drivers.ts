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
