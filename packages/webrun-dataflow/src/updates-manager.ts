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
 * Seeds for `run` / `exec`. Discriminated union — pick one of:
 *
 * - `{ signals }` — start from changed signals; the manager calls the cells
 *   that consume them and their downstream cascade.
 * - `{ cells }` — start from explicit cell ids; the manager calls those
 *   cells and their downstream cascade. Used to resume a previously
 *   interrupted activation: pass the cells whose handlers returned `false`
 *   last time so the cascade finishes before the next sweep starts.
 *
 * Omit the argument entirely to run probers (cells with no inputs) and
 * everything they cascade into.
 */
export type RunSeeds =
  | { signals: Iterable<Signal>; cells?: never }
  | { cells: Iterable<CellId>; signals?: never };

/**
 * Stage events yielded by `run`. The caller can drive the activation one
 * stage at a time, pausing between calls to inspect state or persist
 * progress, and decide whether to keep iterating or close the generator.
 *
 * Order: exactly one `begin`, zero or more `call`s in topological order,
 * exactly one `end`. All events of a single activation carry the same
 * `transactionId`.
 */
export type StageInfo =
  | { type: "begin"; transactionId: number }
  | { type: "end"; transactionId: number }
  | {
      type: "call";
      transactionId: number;
      cellId: CellId;
      /** The cell's last successful tx — what the handler received as `updateId`. */
      updateId: number;
      /** Result of the handler call: `true` = finished, `false` = interrupted (or threw). */
      result: boolean;
    };

/**
 * Drives handler execution over a `DataflowGraph`. Each activation allocates
 * one transaction id, computes the topologically-ordered cell list, and
 * invokes each cell's registered handler. Handlers that return `true` have
 * their tx recorded; `false` and thrown exceptions leave the store untouched
 * (exceptions are forwarded to `onError`).
 *
 * `run` is an async generator yielding `StageInfo` events. The caller can
 * iterate one stage at a time, suspending the activation between cells and
 * resuming it on the next `next()`. Use `exec` if you don't need that
 * control — it iterates the generator to completion and returns void.
 *
 * Activations are serialized by an in-flight guard. The guard is set when
 * generator iteration begins (first `next()`) and cleared when the generator
 * finishes or is closed. A second `run()` whose iteration begins while
 * another generator is still in progress throws.
 */
export class UpdatesManager {
  private running = false;

  constructor(private readonly options: UpdatesManagerOptions) {}

  async *run(seeds?: RunSeeds): AsyncGenerator<StageInfo> {
    if (this.running) {
      throw new Error("UpdatesManager.run is already in progress");
    }
    this.running = true;
    try {
      const transactionId = await this.options.store.newTransactionId();
      yield { type: "begin", transactionId };
      for (const cellId of this.cellsToRun(seeds)) {
        const stage = await this.executeCell(cellId, transactionId);
        if (stage) yield stage;
      }
      yield { type: "end", transactionId };
    } finally {
      this.running = false;
    }
  }

  /**
   * Convenience: iterate `run(seeds)` to completion and resolve. Use this
   * when you don't need per-stage observation.
   */
  async exec(seeds?: RunSeeds): Promise<void> {
    for await (const _ of this.run(seeds)) {
      // drain
    }
  }

  private async executeCell(cellId: CellId, transactionId: number): Promise<StageInfo | undefined> {
    const { store, handlers, onError } = this.options;
    if (!Object.hasOwn(handlers, cellId)) return undefined;
    const handler = handlers[cellId];
    if (!handler) return undefined;
    const updateId = await store.getCellTransaction(cellId);
    let result = false;
    try {
      result = await handler({ updateId, transactionId });
    } catch (error) {
      try {
        onError?.(cellId, error);
      } catch {
        // onError is a passive notifier; a throwing logger must not abort the run.
      }
    }
    if (result) await store.setCellTransaction(cellId, transactionId);
    return { type: "call", transactionId, cellId, updateId, result };
  }

  private cellsToRun(seeds?: RunSeeds): CellId[] {
    const { graph } = this.options;
    if (seeds === undefined) {
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
    if ("signals" in seeds && seeds.signals !== undefined) {
      return graph.getExecutionOrder(seeds.signals);
    }
    if ("cells" in seeds && seeds.cells !== undefined) {
      return graph.getExecutionOrderFromCells(seeds.cells);
    }
    return [];
  }
}
