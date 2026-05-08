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

## License

MIT.
