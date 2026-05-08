import type { CellDefinition, CellId, Signal } from "./types.js";

/**
 * Signal-driven dataflow graph.
 *
 * A cell declares the signals it reads (`inputs`) and the signals it writes
 * (`outputs`). Multiple producers per signal are allowed. Given a set of
 * changed signals, `getExecutionOrder` returns the cells that must run, in a
 * valid topological order, under barrier semantics:
 *
 *     "A consumer must run after ALL producers of its inputs that are
 *      themselves scheduled in this execution."
 */
export class DataflowGraph {
  private readonly cells = new Map<CellId, CellDefinition>();
  private readonly signalToConsumers = new Map<Signal, Set<CellId>>();
  private readonly signalToProducers = new Map<Signal, Set<CellId>>();

  constructor(cellDefs: readonly CellDefinition[]) {
    for (const cell of cellDefs) {
      if (this.cells.has(cell.id)) {
        throw new Error(`Duplicate cell id: ${cell.id}`);
      }
      this.cells.set(cell.id, cell);

      for (const input of cell.inputs) {
        addToSetMap(this.signalToConsumers, input, cell.id);
      }
      for (const output of cell.outputs) {
        addToSetMap(this.signalToProducers, output, cell.id);
      }
    }
  }

  getAllCells(): CellId[] {
    return [...this.cells.keys()];
  }

  getCellInputs(cellId: CellId): Signal[] {
    return [...(this.cells.get(cellId)?.inputs ?? [])];
  }

  getCellOutputs(cellId: CellId): Signal[] {
    return [...(this.cells.get(cellId)?.outputs ?? [])];
  }

  getCellsConsuming(signal: Signal): Set<CellId> {
    return new Set(this.signalToConsumers.get(signal) ?? []);
  }

  getCellsProducing(signal: Signal): Set<CellId> {
    return new Set(this.signalToProducers.get(signal) ?? []);
  }

  /**
   * Main API. Returns the impacted cells in a valid execution order.
   * Throws if the impacted subgraph contains a cycle.
   */
  getExecutionOrder(changedSignals: Iterable<Signal>): CellId[] {
    const seeds = this.findSeedCells(changedSignals);
    const impacted = this.propagateDownstream(seeds);
    return this.topoSort(impacted);
  }

  // -- Step 1: cells that directly consume a changed signal ----------------

  private findSeedCells(signals: Iterable<Signal>): Set<CellId> {
    const seeds = new Set<CellId>();
    for (const signal of signals) {
      const consumers = this.signalToConsumers.get(signal);
      if (!consumers) continue;
      for (const cellId of consumers) seeds.add(cellId);
    }
    return seeds;
  }

  // -- Step 2: forward BFS through outputs → consumers ---------------------

  private propagateDownstream(seeds: Set<CellId>): Set<CellId> {
    const impacted = new Set<CellId>(seeds);
    const queue: CellId[] = [...seeds];

    while (queue.length > 0) {
      const cellId = queue.shift() as CellId;
      const cell = this.cells.get(cellId);
      if (!cell) continue;

      for (const output of cell.outputs) {
        const consumers = this.signalToConsumers.get(output);
        if (!consumers) continue;
        for (const next of consumers) {
          if (!impacted.has(next)) {
            impacted.add(next);
            queue.push(next);
          }
        }
      }
    }
    return impacted;
  }

  // -- Step 3: filtered Kahn's algorithm on the impacted subgraph ----------

  private topoSort(impacted: Set<CellId>): CellId[] {
    // deps[A]    = producers (within `impacted`) that A depends on
    // reverse[B] = cells (within `impacted`) that depend on B
    const deps = new Map<CellId, Set<CellId>>();
    const reverse = new Map<CellId, Set<CellId>>();

    for (const cellId of impacted) {
      const cell = this.cells.get(cellId);
      if (!cell) continue;
      const cellDeps = new Set<CellId>();

      for (const input of cell.inputs) {
        const producers = this.signalToProducers.get(input);
        if (!producers) continue;
        for (const producer of producers) {
          if (producer !== cellId && impacted.has(producer)) {
            cellDeps.add(producer);
            addToSetMap(reverse, producer, cellId);
          }
        }
      }
      deps.set(cellId, cellDeps);
    }

    const inDegree = new Map<CellId, number>();
    for (const cellId of impacted) {
      inDegree.set(cellId, deps.get(cellId)?.size ?? 0);
    }

    const queue: CellId[] = [];
    for (const [cellId, deg] of inDegree) {
      if (deg === 0) queue.push(cellId);
    }

    const result: CellId[] = [];
    while (queue.length > 0) {
      const current = queue.shift() as CellId;
      result.push(current);

      const dependents = reverse.get(current);
      if (!dependents) continue;
      for (const dependent of dependents) {
        const deg = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, deg);
        if (deg === 0) queue.push(dependent);
      }
    }

    if (result.length !== impacted.size) {
      const seen = new Set(result);
      const remaining = [...impacted].filter((c) => !seen.has(c));
      throw new Error(`Cycle detected among cells: ${remaining.join(", ")}`);
    }

    return result;
  }
}

function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) {
    set = new Set<V>();
    map.set(key, set);
  }
  set.add(value);
}
