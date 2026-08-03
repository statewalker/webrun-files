import type { CellId } from "./types.js";

/**
 * Persistence-shaped interface for the bookkeeping the updates manager needs:
 * a monotonic transaction-id allocator plus a per-cell record of the last
 * successful transaction.
 *
 * Only successful runs (handler returned `true`) are recorded — failed or
 * partial runs leave the cell's transaction unchanged.
 *
 * Implementations must guarantee:
 *
 * - `newTransactionId()` returns strictly increasing values across the lifetime
 *   of the store. Successive calls never repeat.
 * - `getCellTransaction(cell)` returns `0` for a cell that has never been
 *   recorded (initial state).
 * - `getCellsTransactions(sinceTx?)` yields all cells whose recorded
 *   transaction id is greater than `sinceTx` (or all recorded cells when
 *   `sinceTx` is omitted). Iteration order is unspecified.
 */
export interface TransactionStore {
  /** Allocate a new strictly-monotonic transaction id. */
  newTransactionId(): Promise<number>;

  /**
   * Record the transaction id for a cell. Should be called only after a
   * handler has returned `true` for that cell.
   */
  setCellTransaction(cell: CellId, transactionId: number): Promise<void>;

  /**
   * Read the last recorded transaction id for a cell, or `0` if the cell has
   * never been recorded.
   */
  getCellTransaction(cell: CellId): Promise<number>;

  /**
   * Iterate over all recorded cells with their last transaction ids. When
   * `sinceTransactionId` is provided, only cells with `transactionId >
   * sinceTransactionId` are yielded.
   */
  getCellsTransactions(
    sinceTransactionId?: number,
  ): AsyncGenerator<[cell: CellId, transactionId: number]>;

  /** Forget the recorded transaction id for a cell. */
  removeCellTransactions(cell: CellId): Promise<void>;
}
