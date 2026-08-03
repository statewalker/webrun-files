# @statewalker/webrun-dataflow

Signal-driven dataflow graph: forward impact propagation + filtered Kahn topological sort. Zero runtime dependencies.

## The problem it solves

Many real systems share the same shape: **something upstream changes, and a cascade of downstream work has to catch up** — in the right order, without redoing work that's already done, without losing progress if something fails, and without melting the machine when a thousand things change at once.

Hand-rolling that for every pipeline ends up reinventing the same wheel: queues, watermarks, retry logic, ordering hacks, "is this already up to date?" checks, ad-hoc resumption flags. `webrun-dataflow` is that wheel, factored out and made declarative.

Concretely, it gives you:

- **Incremental work by URI.** Each handler sees only what changed since *its* last successful run — not the whole world. Sweep a million-file repo and a no-op activation costs almost nothing.
- **Batching without saturation.** Handlers can choose to process a slice of the pending entries, return `false` ("more to do"), and be re-invoked on the next sweep. Backpressure is just "do less per call."
- **Resumable on failure.** A handler that throws or returns `false` leaves its bookmark untouched. Next activation replays exactly the same `updateId`, so progress picks up where it stopped — no compensating actions, no "did I already do this?" guesswork.
- **Guaranteed convergence.** As long as inputs eventually stop changing, the cascade reaches a fixed point where every cell's bookmark equals the latest upstream stamp. Re-runs over a quiet system are structural no-ops.
- **Order without coordination.** The topological sort guarantees a consumer only fires after every upstream producer that *also* has work to do has finished. No timestamps, no priorities, no race windows.
- **Deletes are just another signal.** Tombstone signals flow through the same cascade — no parallel "deletion pipeline" to maintain.
- **Asynchronous, decoupled stages.** The store mediates between handlers; nobody passes data hand-to-hand. Add a new consumer of an existing signal and the graph picks it up; remove one and nothing else cares.

In one line: **describe the graph once, write idempotent handlers, and let the runtime turn "something changed" into the minimum correct cascade — every time, even after crashes.**

See [docs/use-cases.md](docs/use-cases.md) for example domains beyond content pipelines — ETL, CI/CD, cache invalidation, IoT, ML, and more.

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
import { DataflowGraph } from "@statewalker/webrun-dataflow";

const graph = new DataflowGraph([
  { id: "A", inputs: [],     outputs: ["x", "n"] },
  { id: "B", inputs: ["n"],  outputs: ["x"] },
  { id: "C", inputs: ["x"],  outputs: [] },
]);

graph.getExecutionOrder(["n"]);
// → ["B", "C"]   (A produces n but is not impacted by changing n itself)

graph.getExecutionOrder(["x"]);
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
  { id: "A", inputs: ["s"], outputs: ["x"] },
  { id: "B", inputs: ["x"], outputs: ["y"] },
  { id: "C", inputs: ["x"], outputs: ["z"] },
  { id: "D", inputs: ["y", "z"], outputs: [] },
]);

g.getExecutionOrder(["s"]);
// → A first, then B and C in either order, then D
```

### Multi-producer barrier

```ts
const g = new DataflowGraph([
  { id: "A", inputs: ["s"], outputs: ["x"] },
  { id: "B", inputs: ["s"], outputs: ["x"] },
  { id: "C", inputs: ["x"], outputs: [] },
]);

g.getExecutionOrder(["s"]);
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
import { InMemoryTransactionStore } from "@statewalker/webrun-dataflow";

const store = new InMemoryTransactionStore();
const tx = await store.newTransactionId(); // 1, 2, 3, ...
await store.setCellTransaction("ExtractContent", tx);
await store.getCellTransaction("ExtractContent"); // → tx
```

Persistent backends (SQL, KV) ship as separate packages and implement the same interface.

## Updates store

The third leaf of the package. `UpdatesStore` holds **two relations**, both keyed by signal channel:

- `updates(signal, uri) → stamp` — "the URI changed on this signal at stamp `s`". Written by `setUpdate`, read by `readEntries` and `readUpdates`.
- `handled(signal, cell, uri) → stamp` — "this cell has caught up to that change as of stamp `s`". Written by `handleUpdate`, consulted (never yielded) by `readUpdates`, reset by `clearHandled`.

Together with `DataflowGraph` (topology) and `TransactionStore` (per-cell last-success tx), it answers the questions handlers need: *"what changed on signal X that I haven't handled yet?"* and *"what am I marking changed on signal Y right now?"* — with each consumer tracking its progress **independently**, so two cells can consume the same `(signal, uri)` change without interfering.

### `UpdatesStore` interface

```ts
interface UpdateEntry {
  signal: Signal;
  uri: string;
  stamp: number;
}

interface HandledEntry {
  signal: Signal;
  uri: string;
  cell: string;
  stamp: number;
}

type ReadOrderBy = "stamp" | "uri"; // default "stamp"

interface UpdatesStore {
  // --- reads ---
  readEntries(opts: {
    signal: Signal;
    since: number;          // exclusive: yields stamp > since
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry>;

  readUpdates(opts: {
    signal: Signal;
    cell: string;           // per-cell watermark; absent handled stamp == 0
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry>;

  // --- updates relation ---
  setUpdate(entry: UpdateEntry): Promise<void>;
  setUpdates(entries: ReadonlyArray<UpdateEntry>): Promise<void>;

  // --- handled relation ---
  handleUpdate(entry: HandledEntry): Promise<void>;
  handleUpdates(entries: ReadonlyArray<HandledEntry>): Promise<void>;
  clearHandled(key: { signal: Signal; cell: string }): Promise<number>;

  // --- removal (cascades into handled) ---
  removeUpdate(key: { signal: Signal; uri: string }): Promise<void>;
  removeUpdates(keys: ReadonlyArray<{ signal: Signal; uri: string }>): Promise<void>;
}
```

Exact semantics:

- **`setUpdate` — upsert by `(signal, uri)`, blind replace.** Each call overwrites the previous stamp for that pair; no history is retained. The store does **not** enforce monotonicity — a smaller stamp replaces a larger one. A non-finite stamp (`NaN`, `Infinity`) is rejected (throws). Entries are pure pointers `{ signal, uri, stamp }`; the data the URI addresses lives in the caller's domain store.
- **`handleUpdate` — upsert by `(signal, cell, uri)`, blind replace.** Records that `cell` has handled `(signal, uri)` at `stamp` (intended to be the upstream stamp the cell just observed). Same finite-stamp guard. **Never touches `updates` rows** and never affects another cell's handled rows.
- **`readEntries({ signal, since })` — raw, watermark-free read.** Yields every `updates` row on `signal` with `stamp > since` (strict). `since = 0` reads everything. No `cell` dimension.
- **`readUpdates({ signal, cell })` — per-cell diff.** For each `uri` present in `updates[signal]`, yields the entry iff its update stamp is strictly greater than that cell's handled stamp for the same uri (absent handled stamp treated as `0`). A uri present only as handled state (no `updates` row) is never yielded.
- **`clearHandled({ signal, cell })` — watermark reset.** Removes every handled row recorded by `cell` against `signal` (so all of that signal's updates re-appear in the cell's next `readUpdates`). Returns the number of rows removed. Touches no `updates` row and no other cell's handled rows — so resetting one consumer leaves siblings sharing the same input untouched.
- **`removeUpdate({ signal, uri })` — cascading delete.** Removes the `updates` row **and** every cell's handled row for that same `(signal, uri)`. Idempotent (no-op if absent). The cascade prevents a re-created uri from being masked by a stale handled stamp.
- **Ordering (`orderBy`).** Both reads default to `"stamp"` (update-stamp ascending). `"uri"` yields URI-ascending — the order `readCellUpdates` relies on to merge several per-signal streams with O(1) buffering. Same set either way; only the order differs.
- **URI-prefix filter.** `uriPrefix` (on both reads) restricts to entries whose `uri.startsWith(uriPrefix)`; an empty/absent prefix means no filter. Useful for "all files under folder X" or "all chunks of file Y" (when chunk URIs are `<fileUri>#<chunkId>`).
- **Batch ops.** `setUpdates` / `handleUpdates` / `removeUpdates` are exactly N sequential single calls in iteration order — no atomicity promise.

### Two consumption models

A cell needs a *watermark* — "how far have I caught up?" — to read only what's new. The store supports two, and you pick per cell:

**1. Coarse, per-cell transaction watermark** (`readEntries` + `since: updateId`). The watermark is the cell's last successful `transactionId` (from `TransactionStore`, supplied to the handler as `updateId`). Simple and adequate when a cell consumes a single signal and "everything stamped after my last successful run" is the right delta.

```ts
function newExtractor(deps: { files: FilesApi; updatesStore: UpdatesStore }): CellHandler {
  return async ({ updateId, transactionId }) => {
    for await (const { uri } of deps.updatesStore.readEntries({ signal: "files", since: updateId })) {
      await saveContentToDomainStore(uri, extract(await deps.files.read(uri)));
      await deps.updatesStore.setUpdate({ signal: "content", uri, stamp: transactionId });
    }
    return true; // only on full completion → TransactionStore advances → resumable
  };
}
```

**2. Fine, per-cell handled watermark** (`readUpdates` / `readCellUpdates` + `handleUpdate`). The watermark is per `(signal, cell, uri)`. Use this when **multiple cells consume the same signal and must handle each change independently**, or for **sink/fan-out cells** that have no single output signal to act as their watermark. Each cell advances its own watermark by calling `handleUpdate` on the input it just processed:

```ts
import { readCellUpdates } from "@statewalker/webrun-dataflow";

// Two cells both consume "file-source"; each tracks the same file independently.
function newPreviewer(deps: { graph: DataflowGraph; updatesStore: UpdatesStore }): CellHandler {
  const CELL = "Previewer";
  return async () => {
    for await (const entry of readCellUpdates(deps.updatesStore, deps.graph, CELL)) {
      const changed = await renderPreview(entry.uri); // false if output unchanged
      // Advance the watermark on EVERY observed uri — work, skip, or throw —
      // so a stuck item can't loop forever and the cascade converges.
      await deps.updatesStore.handleUpdate({
        signal: entry.signal, uri: entry.uri, cell: CELL, stamp: entry.stamp,
      });
      // Announce downstream ONLY when output actually changed, propagating the
      // observed stamp. Skips do NOT re-stamp the output → no spurious cascade.
      if (changed) {
        await deps.updatesStore.setUpdate({ signal: "preview", uri: entry.uri, stamp: entry.stamp });
      }
    }
    return true;
  };
}
```

> **Watermark vs. output, decoupled.** In the fine model, "I consumed my input" (`handleUpdate`, always) is a separate fact from "I produced an output" (`setUpdate`, only on real change). Conflating them — advancing the downstream signal on every observed uri, including no-op skips — makes unchanged content ripple needlessly through the rest of the graph. Keep them apart.

### `readCellUpdates` + `aggregateByUri` — graph-aware per-cell diff

`readCellUpdates(store, graph, cellId, { uriPrefix? })` is the fine-model reader. It discovers the cell's input signals via `graph.getCellInputs(cellId)` and, for each, opens `readUpdates({ signal, cell: cellId, orderBy: "uri" })`, then merges them with a streaming k-way URI merge.

- The watermark dimension is the **`cellId` itself** — not any output signal — so **sink cells (inputs, no outputs) work** and **probers (no inputs) yield nothing**.
- Output is **URI-ascending**. A uri fresh on N of the cell's input signals appears N times; same-uri entries are emitted adjacently in `graph.getCellInputs` declaration order, so a consumer can collapse per-uri in one forward pass.
- Memory is O(number of input signals), independent of how many URIs match — and the merge is lazy, so a consumer that `break`s early stops the underlying reads.

```ts
import { readCellUpdates, aggregateByUri } from "@statewalker/webrun-dataflow";

// One record per uri, with every contributing upstream entry:
const byUri = await aggregateByUri(readCellUpdates(store, graph, "Index"));
for (const [uri, entries] of byUri) {
  // entries = the fresh updates across this cell's inputs for `uri`
}
```

After handling a yielded entry, call `handleUpdate` with `stamp >= entry.stamp` to advance the watermark; otherwise the uri reappears next call. To force a full re-run of one cell (and, via re-stamped outputs, its downstream), call `clearHandled` on each of its input signals.

### `InMemoryUpdatesStore`

Reference implementation backed by two maps — `Map<Signal, Map<Uri, Stamp>>` (updates) and `Map<Signal, Map<Cell, Map<Uri, Stamp>>>` (handled). State lives in this process; nothing persists across restarts. The constructor accepts an optional serialized state, and `snapshot()` / `toJSON()` dump it:

```ts
import { InMemoryUpdatesStore } from "@statewalker/webrun-dataflow";

const store = new InMemoryUpdatesStore();
await store.setUpdate({ signal: "files", uri: "f1", stamp: 1 });
await store.handleUpdate({ signal: "files", uri: "f1", cell: "Extractor", stamp: 1 });

// Round-trip via JSON (both relations survive):
const restored = new InMemoryUpdatesStore(JSON.parse(JSON.stringify(store)));
```

The serialized shape is a JSON-safe object with both relations:

```ts
type SerializedUpdatesStore = {
  updates: { [signal: string]: { [uri: string]: number } };
  handled: { [signal: string]: { [cell: string]: { [uri: string]: number } } };
};
```

Both directions are defensively copied: the store never holds a live reference to caller-provided objects, and a returned snapshot can be mutated freely. For backward compatibility the constructor also accepts a **legacy flat** `{ [signal]: { [uri]: stamp } }` object (no `updates`/`handled` keys), loading it as the `updates` relation with empty handled state.

This serialized shape is private to `InMemoryUpdatesStore` (and file-backed wrappers that reuse it) — it is **not** part of the `UpdatesStore` interface.

### Storage-agnostic — maps onto a database

The `UpdatesStore` interface references no key encoding, separator, or serialization, so it translates directly onto two relational tables:

```sql
CREATE TABLE updates (signal TEXT, uri TEXT, stamp BIGINT, PRIMARY KEY (signal, uri));
CREATE TABLE handled (signal TEXT, cell TEXT, uri TEXT, stamp BIGINT,
  PRIMARY KEY (signal, cell, uri),
  FOREIGN KEY (signal, uri) REFERENCES updates(signal, uri) ON DELETE CASCADE);
```

`readUpdates` is an indexed left-join (`updates LEFT JOIN handled … WHERE u.stamp > COALESCE(h.stamp, 0)`); `removeUpdate`'s cascade is the foreign key's `ON DELETE CASCADE` (free, not the in-memory O(cells) loop); `clearHandled` is `DELETE FROM handled WHERE signal=? AND cell=?`. Nothing in the interface requires loading a full snapshot, so a DB backend needs no `snapshot()`/`toJSON()`.

### End-to-end scenario — scanner + cascade + re-indexing

A worked example of the **coarse model** (per-cell transaction watermark). A typical pipeline starts with a *scanner* cell. The scanner observes some external source (a files map, a directory, an inbox), detects what changed since its last visit, and publishes the changes onto a domain signal. Downstream cells transform, derive, embed, index — each one reading from one signal and writing to another, all coordinated through the same `UpdatesStore`.

```
         scan
          │
          ▼
     [ScanFiles]
          │
          ▼
        files ─────────────────────┐
          │                        │
          ▼                        │
   [ExtractContent]                │
          │                        │
          ▼                        │
       content                     │
          │                        │
          ▼                        │
    [SplitContent]                 │
          │                        │
          ▼                        │
        chunks ────────────────────┤
          │                        │
          ▼                        │
    [EmbedChunks]                  │
          │                        │
          ▼                        │
     embeddings ───────────────────┤
                                   │
                                   ▼
                                [Index]
```

`[PascalCase]` boxes are cells; kebab-case bare names are signals. Note the fan-out — `files` feeds both `ExtractContent` and `Index`, `chunks` feeds both `EmbedChunks` and `Index` — and the fan-in: `Index` only fires after `files`, `chunks`, *and* `embeddings` have all settled for this activation (barrier semantics).

```ts
const graph = new DataflowGraph([
  { id: "ScanFiles",      inputs: ["scan"],                            outputs: ["files"] },
  { id: "ExtractContent", inputs: ["files"],                           outputs: ["content"] },
  { id: "SplitContent",   inputs: ["content"],                         outputs: ["chunks"] },
  { id: "EmbedChunks",    inputs: ["chunks"],                          outputs: ["embeddings"] },
  { id: "Index",          inputs: ["files", "chunks", "embeddings"],   outputs: [] },
]);
```

`ScanFiles` is responsible for tracking per-source change markers itself — for example, comparing each file's `updatedAt` against the last value it observed for that URI — and emitting `{ signal: "files", uri, stamp: transactionId }` only for files that actually changed:

```ts
function newFilesScanner(deps: { files: Map<string, { body: string; updatedAt: number }>; updatesStore: UpdatesStore }): CellHandler {
  const lastSeen = new Map<string, number>();
  return async ({ transactionId }) => {
    for (const [uri, file] of deps.files) {
      if (file.updatedAt > (lastSeen.get(uri) ?? 0)) {
        await deps.updatesStore.setUpdate({ signal: "files", uri, stamp: transactionId });
        lastSeen.set(uri, file.updatedAt);
      }
    }
    return true;
  };
}
```

**Initial pass.** `manager.exec({ signals: ["scan"] })` allocates a fresh `transactionId`, walks the graph in topological order, and lets each cell read its inputs through `UpdatesStore`. `ScanFiles` publishes new `files` entries; `ExtractContent` reads them, writes to its content store and publishes `content` entries; `SplitContent` reads `content`, publishes `chunks`; `EmbedChunks` reads `chunks`, publishes `embeddings`; `Index` reads all three and updates its index. By the end of the run every cell's recorded transaction has advanced.

**Re-indexing.** When a file changes on disk, the caller mutates the source (`files.set("f1", { body: "...", updatedAt: 2 })`) and runs `manager.exec({ signals: ["scan"] })` again. `ScanFiles` notices the bumped `updatedAt` and re-emits `{ signal: "files", uri: "f1", stamp: tx2 }`. Because `UpdatesStore` upserts by `(signal, uri)`, the row's stamp moves from `tx1` to `tx2`. Every downstream cell's next `readEntries({ signal, since: updateId })` query (where `updateId` is the cell's last recorded tx, less than `tx2`) yields the URI again, and the cell re-processes it. Re-indexing falls out of the contract — there is no special "re-index" code path.

**No-op re-runs.** If nothing changed (no file's `updatedAt` advanced), `ScanFiles` emits nothing, every downstream cell reads zero entries, and the cascade is a no-op. Idempotence is structural.

> The same pipeline written in the **fine model** would swap `readEntries({ signal, since: updateId })` for `readCellUpdates(store, graph, cellId)` and the trailing `setUpdate(output)` for `handleUpdate(input)` + a conditional `setUpdate(output)` — needed once two cells consume the same signal independently (e.g. an `Index` and a `Previewer` both reading `files`).

### Deletion — tombstone signals + `removeUpdate`

Deletion is propagated as its own signal (a convention, not a contract). When a file disappears, the upstream emits `{ signal: "files:removed", uri }`; downstream cells declare `"files:removed"` (or whatever naming you prefer — `"-files"`, `"files-deleted"`) as an input and react accordingly. The graph's topological order fans the deletion through the cascade just like a creation.

When a tombstone-consuming handler has finished propagating the deletion to its own downstream stores, it cleans up the upstream pair via `removeUpdate` — both the original `"files"` row and the consumed `"files:removed"` row for that URI — so the next sweep does not re-process the same deletion. Because `removeUpdate` cascades into the handled relation, **every cell's watermark for that URI is cleared too**, so a later re-created URI is seen fresh by every consumer. The store enforces nothing about signal naming.

### Caller responsibilities

Things the store deliberately does NOT enforce:

- **Stamp discipline.** Stamps are caller-supplied; the store never derives, validates (beyond finiteness), or compares them across calls. In the coarse model pass the activation's `transactionId`; in the fine model pass the observed upstream `entry.stamp`.
- **Signal & cell naming.** Any string is a valid `signal` or `cell` (spaces and delimiters included) — the store reserves no characters. It does not know which signals a `DataflowGraph` declares; a handler that writes to a signal its cell did not declare as an `output` is a topology bug invisible to the store.
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
} from "@statewalker/webrun-dataflow";

const graph = new DataflowGraph([
  { id: "Detect",  inputs: ["fs-tick"],         outputs: ["files-changed"] },
  { id: "Extract", inputs: ["files-changed"],   outputs: ["extracted"] },
  { id: "Chunk",   inputs: ["extracted"],       outputs: ["chunks"] },
]);
const store = new InMemoryTransactionStore();

const manager = new UpdatesManager({
  graph,
  store,
  handlers: {
    Detect:  async ({ updateId, transactionId }) => { /* ... */ return true; },
    Extract: async ({ updateId, transactionId }) => { /* ... */ return true; },
    Chunk:   async ({ updateId, transactionId }) => { /* ... */ return true; },
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
  if (stage.type === "call" && stage.cellId === "Extract" && !stage.result) {
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

Handlers are expected to be **idempotent** — they may be re-invoked with the same `updateId` after a previous failure. Coordinate per-entry changes between handlers through the [`UpdatesStore`](#updates-store) above, in either the coarse model (read with `since: updateId`, write with `stamp: transactionId`) or the fine model (read with `readCellUpdates` / `readUpdates`, advance with `handleUpdate`, write outputs only on real change). Both make replays skip work that already published.

## License

MIT.
