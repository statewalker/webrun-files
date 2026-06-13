import type { CellId, TransactionStore } from "@statewalker/shared-dataflow";
import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadJson, writeJsonAtomic } from "./json-io.js";

interface Snapshot {
  nextTransactionId: number;
  cellTransactions: { [cellId: string]: number };
}

const EMPTY: Snapshot = { nextTransactionId: 1, cellTransactions: {} };

/**
 * Generic file-backed `TransactionStore`. Persists the next-tx counter and
 * per-cell last-committed tx to one JSON file.
 */
export class FileBackedTransactionStore implements TransactionStore {
  private snap: Snapshot;
  private dirty = false;

  private constructor(
    private readonly files: FilesApi,
    private readonly path: string,
    snapshot: Snapshot,
  ) {
    this.snap = {
      nextTransactionId: snapshot.nextTransactionId,
      cellTransactions: { ...snapshot.cellTransactions },
    };
  }

  static async open(files: FilesApi, path: string): Promise<FileBackedTransactionStore> {
    const found = (await tryReadJson<Snapshot>(files, path)) ?? EMPTY;
    return new FileBackedTransactionStore(files, path, found);
  }

  async newTransactionId(): Promise<number> {
    const id = this.snap.nextTransactionId;
    this.snap.nextTransactionId += 1;
    this.dirty = true;
    return id;
  }

  peekNextTransactionId(): number {
    return this.snap.nextTransactionId;
  }

  async getCellTransaction(cellId: CellId): Promise<number> {
    return this.snap.cellTransactions[cellId] ?? 0;
  }

  async setCellTransaction(cellId: CellId, transactionId: number): Promise<void> {
    this.snap.cellTransactions[cellId] = transactionId;
    this.dirty = true;
  }

  async *getCellsTransactions(sinceTransactionId?: number): AsyncGenerator<[CellId, number]> {
    const since = sinceTransactionId ?? -1;
    for (const [cellId, tx] of Object.entries(this.snap.cellTransactions)) {
      if (tx > since) yield [cellId, tx];
    }
  }

  async removeCellTransactions(cellId: CellId): Promise<void> {
    if (cellId in this.snap.cellTransactions) {
      delete this.snap.cellTransactions[cellId];
      this.dirty = true;
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.files, this.path, this.snap);
    this.dirty = false;
  }
}
