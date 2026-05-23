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

## Updates store

The third leaf of the package. `UpdatesStore` records, per signal channel, the URIs whose most recent change occurred at stamp `s`. Together with `DataflowGraph` (topology) and `TransactionStore` (per-cell last-success tx), it gives handlers the per-entry delta they need to answer two questions: "what URIs changed on signal X since my last successful run?" and "what URIs am I marking changed on signal Y right now?"

### `UpdatesStore` interface

```ts
interface UpdateEntry {
  signal: Signal;
  uri: string;
  stamp: number;
}

interface UpdatesStore {
  readEntries(opts: {
    signal: Signal;
    since: number;
    uriPrefix?: string;
  }): AsyncIterable<UpdateEntry>;

  saveEntry(entry: UpdateEntry): Promise<void>;
  saveEntries(entries: ReadonlyArray<UpdateEntry>): Promise<void>;

  removeEntry(key: { signal: Signal; uri: string }): Promise<void>;
  removeEntries(keys: ReadonlyArray<{ signal: Signal; uri: string }>): Promise<void>;
}
```

Semantics:

- **Upsert by `(signal, uri)`.** Each save overwrites the previous stamp for that pair. No history is retained — the store keeps the latest stamp per pair.
- **Pure pointer entries.** `{ signal, uri, stamp }`, no payload. The data the URI addresses lives in the caller's domain store.
- **Explicit stamps.** The store records whatever stamp the caller supplies — including a smaller one. It does not enforce monotonicity. In normal operation, callers pass the activation's `transactionId`, which is monotonic via `TransactionStore.newTransactionId()`.
- **`since` exclusive, stamp-ascending order.** `readEntries({ signal, since })` yields entries with `stamp > since`, in stamp-ascending order. Use `since = 0` to read everything.
- **Optional URI-prefix filter.** `readEntries({ signal, since, uriPrefix })` restricts to entries whose `uri.startsWith(uriPrefix)`. Useful for queries like "all modified files under folder X" or "all chunks of file Y" (when chunk URIs are addressed as `<fileUri>#<chunkId>`).
- **Idempotent deletion.** `removeEntry({ signal, uri })` erases the row if present; a no-op otherwise.

### `InMemoryUpdatesStore`

Reference implementation backed by `Map<Signal, Map<Uri, Stamp>>`. State lives in this process; nothing persists across restarts. The class accepts an optional `SerializedUpdatesStore` initial state in its constructor and exposes `snapshot()` and `toJSON()` for the dump direction:

```ts
import { InMemoryUpdatesStore } from "@statewalker/shared-dataflow";

const store = new InMemoryUpdatesStore();
await store.saveEntry({ signal: "files", uri: "f1", stamp: 1 });

// Round-trip via JSON:
const blob = JSON.stringify(store);
const restored = new InMemoryUpdatesStore(JSON.parse(blob));
```

The `SerializedUpdatesStore` shape is a JSON-safe nested object — `{ [signal]: { [uri]: stamp } }`. Both directions are defensively copied: the store never holds a live reference to caller-provided objects, and the snapshot returned to a caller can be mutated freely without affecting the store.

Persistent backends ship as separate packages and implement the `UpdatesStore` interface; `snapshot()` / `toJSON()` are in-memory-impl extras, not part of the core contract.

### Wiring with handlers — factory pattern

`UpdatesManager` stays unchanged. Build handlers via ordinary factory functions that close over the store and return a plain `CellHandler`:

```ts
import type { CellHandler, UpdatesStore } from "@statewalker/shared-dataflow";

function newExtractor(deps: {
  files: FilesApi;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async ({ updateId, transactionId }) => {
    for await (const { uri } of deps.updatesStore.readEntries({
      signal: "files",
      since: updateId,
    })) {
      const body = await deps.files.read(uri);
      await saveContentToDomainStore(uri, extract(body));
      await deps.updatesStore.saveEntry({
        signal: "content",
        uri,
        stamp: transactionId,
      });
    }
    return true;
  };
}
```

Returning `true` only when every upstream change has been processed makes the handler trivially resumable: on `false` or a thrown exception, the cell's recorded transaction does not advance, so the same `updateId` is supplied on the next activation and the same upstream entries appear again.

### End-to-end scenario — scanner + cascade + re-indexing

A typical pipeline starts with a *scanner* cell. The scanner observes some external source (a files map, a directory, an inbox), detects what changed since its last visit, and publishes the changes onto a domain signal. Downstream cells transform, derive, embed, index — each one reading from one signal and writing to another, all coordinated through the same `UpdatesStore`.

```ts
const graph = new DataflowGraph([
  { id: "scanner", inputs: ["scan"],                              outputs: ["files"] },
  { id: "extract", inputs: ["files"],                             outputs: ["content"] },
  { id: "chunk",   inputs: ["content"],                           outputs: ["chunks"] },
  { id: "embed",   inputs: ["chunks"],                            outputs: ["embeddings"] },
  { id: "index",   inputs: ["content", "chunks", "embeddings"],   outputs: [] },
]);
```

The scanner is responsible for tracking per-source change markers itself — for example, comparing each file's `updatedAt` against the last value it observed for that URI — and emitting `{ signal: "files", uri, stamp: transactionId }` only for files that actually changed:

```ts
function newFilesScanner(deps: { files: Map<string, { body: string; updatedAt: number }>; updatesStore: UpdatesStore }): CellHandler {
  const lastSeen = new Map<string, number>();
  return async ({ transactionId }) => {
    for (const [uri, file] of deps.files) {
      if (file.updatedAt > (lastSeen.get(uri) ?? 0)) {
        await deps.updatesStore.saveEntry({ signal: "files", uri, stamp: transactionId });
        lastSeen.set(uri, file.updatedAt);
      }
    }
    return true;
  };
}
```

**Initial pass.** `manager.exec({ signals: ["scan"] })` allocates a fresh `transactionId`, walks the graph in topological order, and lets each cell read its inputs through `UpdatesStore`. The scanner publishes new `files` entries; `extract` reads them, writes to its content store and publishes `content` entries; `chunk` reads `content`, publishes `chunks`; `embed` reads `chunks`, publishes `embeddings`; `index` reads all three and updates its index. By the end of the run every cell's recorded transaction has advanced.

**Re-indexing.** When a file changes on disk, the caller mutates the source (`files.set("f1", { body: "...", updatedAt: 2 })`) and runs `manager.exec({ signals: ["scan"] })` again. The scanner notices the bumped `updatedAt` and re-emits `{ signal: "files", uri: "f1", stamp: tx2 }`. Because `UpdatesStore` upserts by `(signal, uri)`, the row's stamp moves from `tx1` to `tx2`. Every downstream cell's next `readEntries({ signal, since: updateId })` query (where `updateId` is the cell's last recorded tx, less than `tx2`) yields the URI again, and the cell re-processes it. Re-indexing falls out of the contract — there is no special "re-index" code path.

**No-op re-runs.** If nothing changed (no file's `updatedAt` advanced), the scanner emits nothing, every downstream cell reads zero entries, and the cascade is a no-op. Idempotence is structural.

### Deletion — tombstone signals + `removeEntry`

Deletion is propagated as its own signal (a convention, not a contract). When a file disappears, the upstream emits `{ signal: "files:removed", uri }`; downstream cells declare `"files:removed"` (or whatever naming you prefer — `"-files"`, `"files-deleted"`) as an input and react accordingly. The graph's topological order fans the deletion through the cascade just like a creation.

When a tombstone-consuming handler has finished propagating the deletion to its own downstream stores, it cleans up the upstream pair via `removeEntry` — both the original `"files"` row and the consumed `"files:removed"` row for that URI — so the next sweep does not re-process the same deletion. The store enforces nothing about signal naming.

### Caller responsibilities

Three things the store deliberately does NOT enforce:

- **Stamp discipline.** Every `saveEntry` uses a stamp the caller chose. The store does not derive, validate, or compare stamps. Pass `transactionId` honestly.
- **Signal naming.** The store accepts any string as a signal. It does not know what signals exist in any `DataflowGraph`. A handler that writes to a signal its cell did not declare as an `output` is a graph-topology bug — invisible to the store.
- **Tombstone naming convention.** The `:removed` (or whatever) convention is yours to set, recorded in your graph topology.

## Updates manager

`UpdatesManager` is the runtime that drives handler execution over the graph using a `TransactionStore`. It exposes two methods:

- **`run(seeds?)`** — an async generator that yields `StageInfo` events. The caller can drive the activation one stage at a time, pausing between cells.
- **`exec(seeds?)`** — convenience: iterates `run` to completion and resolves. Use when you don't need per-stage observation.

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

// External trigger (e.g. fs-watcher fires) — convenience form, drain to completion.
await manager.exec({ signals: ["fs-tick"] });

// Periodic sweep — runs all probers (cells with inputs: []) plus their cascade.
await manager.exec();
```

### Seeds — signals, cells, or none

The argument to `run` / `exec` is a discriminated union:

- `{ signals: Iterable<Signal> }` — start from changed signals. The cells consuming them and their downstream cascade run, in topological order.
- `{ cells: Iterable<CellId> }` — start from explicit cell ids. Those cells plus their downstream cascade run. Used to resume an interrupted activation (see "Restart" below).
- Omitted — run probers (cells with `inputs: []`) and everything they cascade into.

The two seed forms are mutually exclusive; mixing them is a type error.

### Per-activation lifecycle

Per call to `run()` / `exec()`:

1. A new `transactionId` is allocated via `store.newTransactionId()`. **All cells in this activation share it.**
2. The cell list is computed from the seeds (or probers when omitted).
3. Each cell's handler is invoked with `{ updateId: store.getCellTransaction(cellId), transactionId }`.
4. On `true` → `store.setCellTransaction(cellId, transactionId)`. On `false` or thrown → store untouched; thrown errors are forwarded to `onError`.

Activations are serialized. The in-flight guard is set when iteration begins (first `next()`) and cleared when the generator finishes or is closed. A second `run` whose iteration begins while another is still in progress throws.

### Stage events — observing the activation

`run` yields `StageInfo` events as the activation progresses:

```ts
type StageInfo =
  | { type: "begin"; transactionId: number }
  | { type: "end";   transactionId: number }
  | {
      type: "call";
      transactionId: number;
      cellId: CellId;
      updateId: number;   // the cell's prior successful tx, passed to its handler
      result: boolean;    // true = handler finished, false = handler returned false or threw
    };
```

Exactly one `begin`, one `call` per executed cell in topological order, one `end`. All three carry the same `transactionId`.

Stepping the generator yourself lets you (a) checkpoint progress to disk between cells, (b) pause until external state catches up, or (c) abort early:

```ts
const it = manager.run({ signals: ["fs-tick"] });
for await (const stage of it) {
  if (stage.type === "call" && stage.cellId === "extract" && !stage.result) {
    // Extract failed — checkpoint and bail out; the generator's `finally`
    // releases the in-flight guard so the next `run` / `exec` can start.
    await it.return(undefined);
    break;
  }
}
```

### Restart — finalize interrupted cells before the next sweep

When a handler returns `false`, its cell's `TransactionStore` entry does not advance — the cell will re-process the same upstream entries on the next activation. But the next activation usually starts from a *new* upstream change (e.g., the periodic scan). If you want to **finish the previous round** before introducing new work, collect the failed cell ids and pass them back as `{ cells }`:

```ts
const incompleteCells: CellId[] = [];
for await (const stage of manager.run({ signals: ["scan"] })) {
  if (stage.type === "call" && !stage.result) incompleteCells.push(stage.cellId);
}

if (incompleteCells.length > 0) {
  // Finalize last round's interrupted cells + their downstream cascade.
  // Each cell's handler reads with `since: updateId` (still its last
  // successful tx, before this round) and picks up exactly where it left off.
  await manager.exec({ cells: incompleteCells });
}

// Now safe to start the next scan — earlier upstream changes have settled.
await manager.exec({ signals: ["scan"] });
```

This pattern is useful when handlers process upstream entries in batches (returning `false` to signal "more to do"): the operator can drain the pipeline before scanning again, avoiding pile-up.

### Handler contract

```ts
type CellHandler = (params: {
  updateId: number;       // = lastSuccessTx for this cell, or 0
  transactionId: number;  // = activation's tx
}) => Promise<boolean>;
```

Handlers are expected to be **idempotent** — they may be re-invoked with the same `updateId` after a previous failure. The simplest way to coordinate per-entry changes between handlers is the [`UpdatesStore`](#updates-store) above: read upstream entries with `since: updateId`, write downstream entries with `stamp: transactionId`. The store's stamp semantics ensure replays skip work that already published.

## License

MIT.
