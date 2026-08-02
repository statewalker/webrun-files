import type { TransactionStore } from "./transaction-store.js";
import type { CellId } from "./types.js";

/**
 * In-memory `TransactionStore`. State lives in this process; nothing is
 * persisted across restarts. Suitable for tests and single-process use.
 */
export class InMemoryTransactionStore implements TransactionStore {
  private nextTx = 1;
  private readonly cellTransactions = new Map<CellId, number>();

  async newTransactionId(): Promise<number> {
    return this.nextTx++;
  }

  async setCellTransaction(cell: CellId, transactionId: number): Promise<void> {
    this.cellTransactions.set(cell, transactionId);
  }

  async getCellTransaction(cell: CellId): Promise<number> {
    return this.cellTransactions.get(cell) ?? 0;
  }

  async *getCellsTransactions(sinceTransactionId?: number): AsyncGenerator<[CellId, number]> {
    for (const [cell, tx] of this.cellTransactions) {
      if (sinceTransactionId === undefined || tx > sinceTransactionId) {
        yield [cell, tx];
      }
    }
  }

  async removeCellTransactions(cell: CellId): Promise<void> {
    this.cellTransactions.delete(cell);
  }
}
