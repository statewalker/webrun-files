import type { Db } from "@statewalker/db-api";

/** One statement of a transaction. */
export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

/**
 * Runs the statements in order on a transaction's Db and returns, per
 * statement, the rows it changed — zero exactly when it changed nothing. The
 * count is SQLite's `changes()` on the same connection, so index writes are
 * not counted. Call it only inside `inTransaction`; it does nothing but SQL,
 * so a retried transaction callback is safe.
 */
export async function runStatements(tx: Db, statements: SqlStatement[]): Promise<number[]> {
  const counts: number[] = [];
  for (const { sql, params = [] } of statements) {
    await tx.query(sql, params);
    const [row] = await tx.query<{ n: number }>("SELECT changes() AS n");
    counts.push(Number(row.n));
  }
  return counts;
}
