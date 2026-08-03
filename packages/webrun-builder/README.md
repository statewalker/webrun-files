# @statewalker/webrun-builder

A generic, host-agnostic **incremental build engine**. `BuildEngine<THost>`
schedules signal-driven builders over a [`@statewalker/webrun-dataflow`](../webrun-dataflow)
graph, drives file-backed transaction + updates stores over a
[`@statewalker/webrun-files`](../webrun-files) `FilesApi`, and detects source
changes by walking a project tree. It knows nothing about any particular host —
the `host: THost` you construct it with is passed through to every builder
untouched.

## The problem it solves

You have a corpus (a directory of files) and a chain of derivations to keep up to
date over it: scan sources, extract, split, embed, index, reorganize. When a file
changes you want the **minimum correct cascade** — only the affected stages, in
dependency order, resumable if the process dies, without re-doing settled work,
and without a builder starving the event loop when a thousand files change at
once.

`webrun-dataflow` provides the topology and the watermark bookkeeping.
`webrun-builder` is the **runtime** on top of it: a frontier/convergence scheduler
that drives your builders to a fixed point, a built-in source scanner (mtime
change-detection with `sources` / `sources-removed` tombstones), centralized
update / transaction stores persisted to disk, and a cooperative yield/checkpoint
protocol so a long build stays responsive and resumes where it stopped.

The engine is **Project-free**: it carries no notion of a "project" or "adapter".
Whatever context your builders need — including a back-reference to the engine so
they can read their own input deltas — you put on `THost` and the engine hands it
straight through.

## What it is

- A **scheduler.** `run()` repeatedly computes the *frontier* (the latest
  transaction across all cells) and advances the most-downstream stage that is
  behind it and whose producers have all caught up. When every stage is at the
  frontier it scans; a scan that surfaces no change means the pipeline has
  **converged**.
- A **built-in scanner.** The reserved `SourceScanner` cell walks the project
  tree, compares each file's mtime against its last-seen value, and emits
  `sources` for changes and `sources-removed` tombstones for deletions. It honors
  a `.projectignore` file (gitignore-style) at the project root, plus an optional
  caller-supplied ignore predicate.
- **Durable state.** Updates, per-cell transactions, and the scanner's mtime map
  are persisted under `rootPath`/`systemFolder`/`state` (as `updates.json`,
  `transactions.json`, `scanner.json`). Every frontier advance flushes, so a build
  killed mid-run resumes from its last checkpoint.
- **Cooperative yielding.** Builders call `yieldControl()` once per processed
  item; the engine pauses periodically to release the event loop and periodically
  requests a checkpointed interrupt so the build can be re-seeded on the next pass.

## Install

```sh
npm add @statewalker/webrun-builder
```

## Quick start

A builder is an async generator over the injected host. It reads its input deltas,
does its work, `yield`s output updates for downstream builders, and returns `true`
when it drained its input (or `false` to request a re-run). Here the host carries a
back-reference to the engine, so the builder can drain its own input via
`host.engine.readUpdates(...)`:

```ts
import { BuildEngine, NULL_LOGGER, SOURCES_SIGNAL } from "@statewalker/webrun-builder";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

interface Host {
  engine: BuildEngine<Host>;
}

const files = new MemFilesApi();
const host = {} as Host;

const engine = new BuildEngine<Host>({
  files,
  rootPath: "proj",
  systemFolder: ".project",
  logger: NULL_LOGGER,
  host,
});
host.engine = engine;

// One builder: reads `sources`, drains each update, emits an `indexed` update.
engine.registerBuilder({
  id: "Indexer",
  inputs: [SOURCES_SIGNAL],
  outputs: ["indexed"],
  handler: async function* (h) {
    for await (const u of h.engine.readUpdates({ signal: SOURCES_SIGNAL, cell: "Indexer" })) {
      // …do the work for u.uri…
      yield { signal: "indexed", uri: u.uri, stamp: u.stamp };
      await u.handled(); // mark consumed so it doesn't reappear next run
    }
    return true; // input fully drained
  },
});

// Drive the pipeline to convergence.
for await (const progress of engine.run()) {
  // progress: { type: "begin" | "call" | "end", … }
}
```

## Constructor

```ts
new BuildEngine<THost>(opts: BuildContext & { host: THost })

interface BuildContext {
  files: FilesApi;      // where state lives and where sources are scanned
  rootPath: string;     // project root, relative to `files`
  systemFolder: string; // system dir under the root (e.g. ".project")
  logger: Logger;       // structural logger (see below) — required, no fallback
}
```

`BuildContext` is host-neutral: it says *where state lives* and *where the engine
logs*. The generic `host` is carried alongside — not part of `BuildContext` — and
is what each builder handler receives.

## Builders

```ts
type SignalName = string;

interface EmittedUpdate {
  signal: SignalName;
  uri: string;
  stamp: number;
}

type BuilderHandler<THost> = (
  host: THost,
) => AsyncGenerator<EmittedUpdate, boolean | undefined>;

interface RegisteredBuilder<THost> {
  id: string;
  inputs: readonly SignalName[];
  outputs: readonly SignalName[];
  handler: BuilderHandler<THost>;
}
```

A `BuilderHandler<THost>` receives the injected host (never inspected by the
engine), `yield`s an `EmittedUpdate` for each output it produces, and returns
`true`/`undefined` when its input was fully handled or `false` to request a re-run
on the next pass. The engine persists every yielded update to the shared store
before the downstream stage reads it.

Each yielded update advances a downstream signal; each `BuilderUpdate.handled()`
advances *this* builder's per-signal watermark so the same change is not
re-processed:

```ts
interface BuilderUpdate {
  readonly signal: SignalName;
  readonly uri: string;
  readonly stamp: number;
  handled(): Promise<void>;
}
```

A `BuilderProvider<THost>` (`{ builders(): readonly RegisteredBuilder<THost>[] }`)
lets a host's "nature" contribute a set of builders in one place.

## Public API

Methods on `BuildEngine<THost>`:

- **`registerBuilder(builder): () => void`** — register a builder; returns an
  unregister function. The id `SourceScanner` is reserved (throws). Registering or
  unregistering invalidates the cached graph topology.
- **`run(opts?): AsyncGenerator<BuildProgress>`** — run the scanner plus the
  registered builders in dependency order, to convergence, yielding per-stage
  progress. `opts.builders` restricts the run to a subset (and skips scanning). If
  any stage throws, the first error is re-thrown after state is flushed.
- **`readUpdates({ signal, cell }): AsyncIterable<BuilderUpdate>`** — the
  un-handled updates on `signal` for builder `cell`, in URI order. A builder calls
  this (via the host) to drain its own input.
- **`yieldControl(): Promise<boolean>`** — cooperative yield point; builders call
  it once per processed item. Pauses periodically to release the event loop;
  returns `false` periodically (after checkpointing durable state) to ask the
  builder to interrupt so `run()` can re-seed it.
- **`restartFrom(builderId): Promise<void>`** — reset `builderId` and every builder
  downstream of it: clear their handled + transaction watermarks so the next
  `run()` re-derives them. Upstream builders are untouched.
- **`status(): Promise<BuildStatus>`** — per-builder pending-update counts and
  last-run transaction ids, plus the next transaction id.
- **`configureYield(partial): this`** — override the cooperative-yield throttle
  (`YieldConfig`: `pauseEvery`, `pauseMs`, `interruptEvery`, `maxStalledPasses`,
  `scanBatchSize`).
- **`configureSourceIgnore(provider): this`** — inject an extra source-exclusion
  predicate, composed (logical OR) with `.projectignore` and re-read at the start
  of every scan. A uri the predicate excludes is treated exactly like a
  `.projectignore` match (kept out of the source set, pruned via `sources-removed`
  if previously indexed).

### Reserved names

```ts
const SCAN_CELL = "SourceScanner";           // the built-in scanner cell id
const SOURCES_SIGNAL = "sources";            // emitted for changed sources
const SOURCES_REMOVED_SIGNAL = "sources-removed"; // emitted for deletions
```

## The scanner and `.projectignore`

The built-in scanner walks `rootPath` recursively, skipping any path with a
dot-segment (the system folder, `.git`, manifests, …). For each file it compares
mtime against the persisted `scanner.json` map: changed files emit `sources`,
disappeared files emit `sources-removed`. `configureYield({ scanBatchSize })`
caps how many changed sources are emitted per scan (in URI order) so each batch
flows through the whole pipeline before the next is picked up; the full tree is
always walked so removals are detected regardless of the batch limit.

`.projectignore` at the project root is a pragmatic gitignore-style exclusion
list, exposed as standalone helpers:

```ts
import { makeProjectIgnore, compileIgnoreRules } from "@statewalker/webrun-builder";

const ignored = makeProjectIgnore("*.log\nbuild/\n!build/keep.txt");
ignored("app.log");        // → true
ignored("build/out.js");   // → true
ignored("build/keep.txt"); // → false (negation; last matching rule wins)
```

Supported subset: `#` comments and blank lines; `!pattern` negation (last match
wins); `*` within a segment, `**` across segments, `?` one non-slash char; a
pattern with a `/` is anchored to the root, otherwise it matches a name at any
depth; a trailing `/` marks a directory (its subtree is matched). Adding a rule
prunes a previously-indexed source's artifacts, because it is emitted as
`sources-removed` once excluded.

## Logging

The engine writes to a **local structural `Logger`** — any object with `info`,
`warn`, `error`, and `debug` methods (`console` satisfies it). This is defined in
the package itself, so `webrun-builder` needs **no external logging dependency**.
A no-op `NULL_LOGGER` is exported for callers that want to silence engine logging;
`BuildContext.logger` is required and has no fallback.

```ts
interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}
```

## Progress and status

```ts
type BuildProgress =
  | { type: "begin"; transactionId: number }
  | { type: "call"; transactionId: number; builderId: string; result: boolean }
  | { type: "end"; transactionId: number };

interface BuildStatus {
  nextTransactionId: number;
  builders: { id: string; pending: number; lastTransaction: number }[];
}
```

## Dependencies

Runtime: `@statewalker/webrun-dataflow` (topology + stores) and
`@statewalker/webrun-files` (`FilesApi`). No logging dependency — the `Logger` is
a local structural interface.

## License

MIT
