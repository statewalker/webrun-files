import type { DataflowGraph } from "./dataflow-graph.js";
import type { TransactionStore } from "./transaction-store.js";
import type { CellId, Signal } from "./types.js";

export type CellHandler = (params: {
  /** Tx of the most recent successful run for this cell, or `0`. */
  updateId: number;
  /** Tx allocated for the current activation. Shared by all cells in this run. */
  transactionId: number;
}) => Promise<boolean>;

export interface UpdatesManagerOptions {
  graph: DataflowGraph;
  store: TransactionStore;
  handlers: Record<CellId, CellHandler>;
  /** Called when a handler throws. The exception is otherwise swallowed. */
  onError?: (cellId: CellId, error: unknown) => void;
}

/**
 * Drives handler execution over a `DataflowGraph`. Each call to `run()`
 * allocates one transaction id, computes the topologically-ordered cell list
 * for this activation, and invokes each cell's registered handler. Handlers
 * that return `true` have their tx recorded; `false` and thrown exceptions
 * leave the store untouched (exceptions are forwarded to `onError`).
 *
 * Activations are serialized by an in-flight guard: a second `run()` while
 * one is already in progress throws.
 */
export class UpdatesManager {
  private running = false;

  constructor(private readonly options: UpdatesManagerOptions) {}

  async run(seeds?: Iterable<Signal>): Promise<void> {
    if (this.running) {
      throw new Error("UpdatesManager.run is already in progress");
    }
    this.running = true;
    try {
      const transactionId = await this.options.store.newTransactionId();
      for (const cellId of this.cellsToRun(seeds)) {
        await this.executeCell(cellId, transactionId);
      }
    } finally {
      this.running = false;
    }
  }

  private async executeCell(cellId: CellId, transactionId: number): Promise<void> {
    const { store, handlers, onError } = this.options;
    const handler = handlers[cellId];
    if (!handler) return;
    const updateId = await store.getCellTransaction(cellId);
    let ok = false;
    try {
      ok = await handler({ updateId, transactionId });
    } catch (error) {
      onError?.(cellId, error);
    }
    if (ok) await store.setCellTransaction(cellId, transactionId);
  }

  private cellsToRun(seeds?: Iterable<Signal>): CellId[] {
    const { graph } = this.options;
    if (seeds !== undefined) {
      return graph.getExecutionOrder(seeds);
    }
    // No seeds: run all probers (cells with inputs: []) + their downstream cascade.
    const probers = graph.getAllCells().filter((c) => graph.getCellInputs(c).length === 0);
    if (probers.length === 0) return [];
    const proberOutputs = new Set<Signal>();
    for (const p of probers) {
      for (const out of graph.getCellOutputs(p)) proberOutputs.add(out);
    }
    const downstream = graph.getExecutionOrder(proberOutputs);
    // Probers have no inputs, so any order between them is valid; place them first.
    return [...probers, ...downstream];
  }
}
