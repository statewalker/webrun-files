# @statewalker/shared-dataflow

Signal-driven dataflow graph: forward impact propagation + filtered Kahn topological sort. Zero runtime dependencies.

## What it is

A small TypeScript library that models a graph of *cells* connected by *signals*:

- A **cell** declares the signals it reads (`inputs`) and the signals it produces (`outputs`).
- A **signal** can be produced by multiple cells and consumed by multiple cells.
- Given a set of changed signals, `getExecutionOrder` returns the impacted cells in a valid execution order.

## Why it exists

Captures a specific, opinionated execution semantics — **barrier synchronization, not "latest wins"**:

> A consumer must run after **all** producers of its inputs that are themselves scheduled in this execution.

This avoids races without requiring priorities or timestamps; ordering is purely structural.

## How to use

```ts
import { DataflowGraph } from "@statewalker/shared-dataflow";

const graph = new DataflowGraph([
  { id: "A", inputs: [],     outputs: ["X", "N"] },
  { id: "B", inputs: ["N"],  outputs: ["X"] },
  { id: "C", inputs: ["X"],  outputs: [] },
]);

graph.getExecutionOrder(["N"]);
// → ["B", "C"]   (A produces N but is not impacted by changing N itself)

graph.getExecutionOrder(["X"]);
// → ["C"]
```

## Examples

### Diamond

```ts
//        A
//       / \
//      B   C
//       \ /
//        D
const g = new DataflowGraph([
  { id: "A", inputs: ["S"], outputs: ["x"] },
  { id: "B", inputs: ["x"], outputs: ["y"] },
  { id: "C", inputs: ["x"], outputs: ["z"] },
  { id: "D", inputs: ["y", "z"], outputs: [] },
]);

g.getExecutionOrder(["S"]);
// → A first, then B and C in either order, then D
```

### Multi-producer barrier

```ts
const g = new DataflowGraph([
  { id: "A", inputs: ["S"], outputs: ["X"] },
  { id: "B", inputs: ["S"], outputs: ["X"] },
  { id: "C", inputs: ["X"], outputs: [] },
]);

g.getExecutionOrder(["S"]);
// → C runs after BOTH A and B (their order between themselves is free)
```

## Internals

The algorithm runs in three phases on every call to `getExecutionOrder`:

1. **Seed lookup** — for each changed signal, collect its direct consumers via the precomputed `signal → consumers` index. `O(|changed| + |seeds|)`.
2. **Forward propagation** — BFS through `cell.outputs → consumers` to grow the impacted set. Walks downstream only; producers of unchanged signals are not pulled in. `O(V_impacted + E_impacted)`.
3. **Filtered Kahn topological sort** — restrict the dependency graph to the impacted set: a cell depends on impacted producers of its inputs. Run Kahn's algorithm. Cycles confined to the impacted subgraph throw; cycles outside it are silently ignored. `O(V_impacted + E_impacted)`.

### Precomputed indexes

The constructor builds two `Map<Signal, Set<CellId>>` tables — `signalToConsumers` and `signalToProducers` — and never mutates them after construction. Per-execution work scales with the impacted subgraph, not the whole graph.

### Why filter-at-runtime instead of precomputing transitive closure?

Reachability (who is affected) can be precomputed, but **scheduling order** depends on which cells are *also* in the impacted set on this run — different changed-signal sets pull in different producer subsets. Reusing a static transitive closure would still require the per-execution dependency filter, so the savings are marginal for typical graphs and not worth the storage.

### Constraints

- All cell ids must be unique (constructor throws on duplicates).
- Self-loops (a cell whose output feeds its own input) are tolerated — the cell does not depend on itself.
- The impacted subgraph must be acyclic; otherwise `getExecutionOrder` throws.

### Dependencies

Zero runtime dependencies. Dev-only: `tsdown`, `vitest`, `typescript`, `rimraf`.

## Transaction store

Alongside the topology, this package also ships a small bookkeeping interface used by an updates manager that drives handler execution over the graph.

### `TransactionStore` interface

```ts
interface TransactionStore {
  newTransactionId(): Promise<number>;
  setCellTransaction(cell: CellId, transactionId: number): Promise<void>;
  getCellTransaction(cell: CellId): Promise<number>;
  getCellsTransactions(
    sinceTransactionId?: number,
  ): AsyncGenerator<[cell: CellId, transactionId: number]>;
  removeCellTransactions(cell: CellId): Promise<void>;
}
```

- `newTransactionId` returns strictly increasing numbers across the lifetime of the store.
- `setCellTransaction` is called only after a handler returns `true` — failed/partial runs leave the cell's recorded transaction unchanged.
- `getCellTransaction` returns `0` for cells that have never been recorded.
- `getCellsTransactions(since)` yields cells with `recordedTx > since`; with no argument it yields all recorded cells.
- `removeCellTransactions` forgets a cell entirely (e.g., after a config change).

### `InMemoryTransactionStore`

Reference implementation backed by a single counter and a `Map<CellId, number>`. State lives in this process; nothing persists across restarts. Suitable for tests and single-process use.

```ts
import { InMemoryTransactionStore } from "@statewalker/shared-dataflow";

const store = new InMemoryTransactionStore();
const tx = await store.newTransactionId(); // 1, 2, 3, ...
await store.setCellTransaction("extract", tx);
await store.getCellTransaction("extract"); // → tx
```

Persistent backends (SQL, KV) ship as separate packages and implement the same interface.

## Updates manager

`UpdatesManager` is the runtime that drives handler execution over the graph using a `TransactionStore`.

```ts
import {
  DataflowGraph,
  InMemoryTransactionStore,
  UpdatesManager,
} from "@statewalker/shared-dataflow";

const graph = new DataflowGraph([
  { id: "detect",  inputs: ["fs-tick"],         outputs: ["files-changed"] },
  { id: "extract", inputs: ["files-changed"],   outputs: ["extracted"] },
  { id: "chunk",   inputs: ["extracted"],       outputs: ["chunks"] },
]);
const store = new InMemoryTransactionStore();

const manager = new UpdatesManager({
  graph,
  store,
  handlers: {
    detect:  async ({ updateId, transactionId }) => { /* ... */ return true; },
    extract: async ({ updateId, transactionId }) => { /* ... */ return true; },
    chunk:   async ({ updateId, transactionId }) => { /* ... */ return true; },
  },
  onError: (cellId, error) => console.error(`[${cellId}]`, error),
});

// External trigger (e.g. fs-watcher fires)
await manager.run(["fs-tick"]);

// Periodic sweep — runs all probers (cells with inputs: []) plus their cascade
await manager.run();
```

Per call to `run()`:

1. A new `transactionId` is allocated via `store.newTransactionId()`. **All cells in this activation share it.**
2. The cell list is computed:
   - With seeds: `graph.getExecutionOrder(seeds)`.
   - Without seeds: probers (cells with `inputs: []`) + their downstream cascade.
3. Each cell's handler is invoked with `{ updateId: store.getCellTransaction(cellId), transactionId }`.
4. On `true` → `store.setCellTransaction(cellId, transactionId)`. On `false` or thrown → store untouched; thrown errors are forwarded to `onError`.

Activations are serialized: a second `run()` while one is in flight throws.

The handler contract:

```ts
type CellHandler = (params: {
  updateId: number;       // = lastSuccessTx for this cell, or 0
  transactionId: number;  // = activation's tx
}) => Promise<boolean>;
```

Handlers are expected to be **idempotent** — they may be re-invoked with the same `updateId` after a previous failure. Anti-join your input query against your output store using `transactionId` as a stable tag, so previously-published rows are skipped on retry.

## License

MIT.
