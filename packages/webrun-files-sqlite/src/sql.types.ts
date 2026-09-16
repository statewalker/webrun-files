/**
 * The SQL port. Two methods, each sync or async, so node:sqlite, a Durable
 * Object's `ctx.storage.sql` and D1 all satisfy it through a thin driver.
 */
export interface SqlDriver {
  /** Rows as objects keyed by column name. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
  /** Execute one statement for its effect. */
  run(sql: string, ...params: unknown[]): void | Promise<void>;
}
