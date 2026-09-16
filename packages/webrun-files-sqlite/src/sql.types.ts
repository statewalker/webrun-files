/** One statement of a transaction. */
export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

/**
 * The SQL port. Each method may be sync or async, so node:sqlite, a Durable
 * Object's storage and D1 all satisfy it through a thin driver.
 */
export interface SqlDriver {
  /** Rows as objects keyed by column name. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
  /** Execute one statement for its effect. */
  run(sql: string, ...params: unknown[]): void | Promise<void>;
  /**
   * Run the statements in order as one transaction: all apply or none do, and
   * a failure rethrows after rolling back. Returns, per statement, a count that
   * is zero exactly when that statement changed nothing.
   *
   * No statement may depend on reading another's result — D1's `batch()` cannot
   * pass results along — so conditions belong in SQL (`WHERE EXISTS …`).
   */
  transaction(statements: SqlStatement[]): number[] | Promise<number[]>;
}
