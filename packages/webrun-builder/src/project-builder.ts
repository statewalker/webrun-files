import { type CellDefinition, DataflowGraph, readCellUpdates } from "@statewalker/shared-dataflow";
import { type FilesApi, joinPath, tryReadText } from "@statewalker/webrun-files";
import { type Logger, loggerOf } from "../types/logger.js";
import { DEFAULT_SYSTEM_FOLDER, type Project } from "../types/project.js";
import { tryReadJson, writeJsonAtomic } from "./json-io.js";
import { makeProjectIgnore } from "./project-ignore.js";
import { FileBackedTransactionStore } from "./transaction-store.js";
import type {
  BuilderUpdate,
  BuildProgress,
  BuildStatus,
  RegisteredBuilder,
  SignalName,
} from "./types.js";
import { FileBackedUpdatesStore } from "./updates-store.js";

/** Reserved cell id of the built-in generic source scanner. */
export const SCAN_CELL = "SourceScanner";
/** Base signals emitted by the scanner (kebab-case). */
export const SOURCES_SIGNAL: SignalName = "sources";
export const SOURCES_REMOVED_SIGNAL: SignalName = "sources-removed";

interface Stores {
  updates: FileBackedUpdatesStore;
  transactions: FileBackedTransactionStore;
  scannerState: Map<string, number>;
  scannerPath: string;
}

/**
 * Cooperative-yield throttle config. Defaults keep a long build from starving the
 * event loop: a short pause every `pauseEvery` yields, and a re-run-requesting
 * interrupt every `interruptEvery` yields.
 */
export interface YieldConfig {
  /** Pause (await `pauseMs`) once every this many `yieldControl` calls. */
  pauseEvery: number;
  /** Pause duration in ms. */
  pauseMs: number;
  /** Return `false` (request interrupt + re-run) once every this many calls. */
  interruptEvery: number;
  /**
   * Abort `run()` after this many *consecutive* no-progress passes. A healthy build
   * always makes progress (a stage drains, handles ≥1 update, or a scan surfaces
   * work), so the counter only climbs when a builder is genuinely stuck (never
   * draining) or repeatedly throws before handling anything — kept small to fail fast.
   */
  maxStalledPasses: number;
  /**
   * Max changed sources the scanner emits per scan pass (`0` = unlimited). A
   * positive value makes each batch its own transaction, so it traverses the whole
   * pipeline — and the terminal stages dump their top-level artifacts — before the
   * next batch is scanned. Trades more scan passes for incremental availability.
   */
  scanBatchSize: number;
}

const DEFAULT_YIELD_CONFIG: YieldConfig = {
  pauseEvery: 10,
  pauseMs: 10,
  interruptEvery: 10,
  maxStalledPasses: 8,
  scanBatchSize: 0,
};

/**
 * The generic build engine, a project-level adapter resolved via
 * `project.requireAdapter(ProjectBuilder)`. Schedules signal-driven builders over
 * `@statewalker/shared-dataflow`, drives centralized update / transaction stores
 * (persisted under the project system folder), and provides generic source
 * change-detection. Knows nothing wiki-specific; a project's "nature" contributes
 * builders via `registerBuilder` / a `BuilderProvider`.
 */
export class ProjectBuilder {
  private readonly builders = new Map<string, RegisteredBuilder>();
  private graph?: DataflowGraph;
  private stores?: Stores;
  private yieldCounter = 0;
  private yieldCfg: YieldConfig = DEFAULT_YIELD_CONFIG;
  private sourceIgnore?: () => Promise<(uri: string) => boolean>;

  constructor(readonly project: Project) {}

  /** Override the cooperative-yield throttle. */
  configureYield(partial: Partial<YieldConfig>): this {
    this.yieldCfg = { ...this.yieldCfg, ...partial };
    return this;
  }

  /**
   * Inject an additional source-exclusion predicate, composed (logical OR) with the
   * project's `.projectignore` during scanning. The provider is re-invoked at the
   * start of every scan, so the underlying rules can be re-read each run; a uri the
   * predicate excludes is treated exactly like a `.projectignore` match (kept out of
   * the source set, and pruned via `sources-removed` if it was previously indexed).
   * A project's "nature" uses this to contribute its own ignore policy (e.g. the
   * wiki's nested `.indexignore`) without the generic engine knowing about it.
   */
  configureSourceIgnore(provider: () => Promise<(uri: string) => boolean>): this {
    this.sourceIgnore = provider;
    return this;
  }

  private get yieldConfig(): YieldConfig {
    return this.yieldCfg;
  }

  private get filesApi(): FilesApi {
    return this.project.workspace.files;
  }

  private get systemFolder(): string {
    return DEFAULT_SYSTEM_FOLDER;
  }

  private stateDir(): string {
    return joinPath(this.project.path, this.systemFolder, "state");
  }

  /** Register a builder; returns an unregister function. */
  registerBuilder(builder: RegisteredBuilder): () => void {
    if (builder.id === SCAN_CELL) {
      throw new Error(`Builder id "${SCAN_CELL}" is reserved for the source scanner`);
    }
    this.builders.set(builder.id, builder);
    this.graph = undefined; // topology changed
    return () => {
      this.builders.delete(builder.id);
      this.graph = undefined;
    };
  }

  private getGraph(): DataflowGraph {
    if (!this.graph) {
      const defs: CellDefinition[] = [
        {
          id: SCAN_CELL,
          inputs: [],
          outputs: [SOURCES_SIGNAL, SOURCES_REMOVED_SIGNAL],
        },
        ...[...this.builders.values()].map((b) => ({
          id: b.id,
          inputs: [...b.inputs],
          outputs: [...b.outputs],
        })),
      ];
      this.graph = new DataflowGraph(defs);
    }
    return this.graph;
  }

  private async ensureStores(): Promise<Stores> {
    if (this.stores) return this.stores;
    const dir = this.stateDir();
    const files = this.filesApi;
    const updates = await FileBackedUpdatesStore.open(files, joinPath(dir, "updates.json"));
    const transactions = await FileBackedTransactionStore.open(
      files,
      joinPath(dir, "transactions.json"),
    );
    const scannerPath = joinPath(dir, "scanner.json");
    const saved = (await tryReadJson<Record<string, number>>(files, scannerPath)) ?? {};
    this.stores = {
      updates,
      transactions,
      scannerState: new Map(Object.entries(saved)),
      scannerPath,
    };
    return this.stores;
  }

  /**
   * Read the un-handled updates on `signal` for builder `cell`, in URI order.
   * Each yielded `BuilderUpdate.handled()` marks it consumed so it does not
   * reappear on the next run.
   */
  async *readUpdates(opts: { signal: SignalName; cell: string }): AsyncIterable<BuilderUpdate> {
    const { updates } = await this.ensureStores();
    const { signal, cell } = opts;
    for await (const e of updates.readUpdates({
      signal,
      cell,
      orderBy: "uri",
    })) {
      yield {
        signal: e.signal,
        uri: e.uri,
        stamp: e.stamp,
        handled: async () => {
          await updates.handleUpdate({
            signal: e.signal,
            uri: e.uri,
            cell,
            stamp: e.stamp,
          });
        },
      };
    }
  }

  /**
   * Cooperative yield point for long-running builders. Builders MUST call this once
   * per processed item. It pauses briefly every `pauseEvery` calls to release the
   * event loop, and returns `false` every `interruptEvery` calls to request the
   * builder interrupt (return `false`) so `run()` can re-seed it on the next pass.
   */
  async yieldControl(): Promise<boolean> {
    const cfg = this.yieldConfig;
    this.yieldCounter += 1;
    if (cfg.pauseEvery > 0 && this.yieldCounter % cfg.pauseEvery === 0) {
      await new Promise<void>((r) => setTimeout(r, cfg.pauseMs));
    }
    if (cfg.interruptEvery > 0 && this.yieldCounter % cfg.interruptEvery === 0) {
      // Checkpoint at the cooperative interrupt: work done so far is made durable,
      // so a build killed here resumes from this point instead of re-running.
      if (this.stores) await this.flush(this.stores);
      return false;
    }
    return true;
  }

  /**
   * Run the pipeline: the built-in scanner (mtime detection → `sources`) plus the
   * registered builders, in signal-dependency order. Yields per-stage progress.
   *
   * Convergence drives every stage to the latest transaction — the **frontier**.
   * Each advance flushes state immediately, so a build killed mid-run resumes where
   * it stopped. When a scan surfaces no change, the pipeline has converged.
   */
  async *run(opts?: { builders?: string[] }): AsyncGenerator<BuildProgress> {
    const stores = await this.ensureStores();
    const graph = this.getGraph();
    const errors: unknown[] = [];

    // Drive a registered builder's generator handler, persisting each emitted
    // update. Returns the generator's final value (`false` = interrupted).
    const runBuilder = async (id: string): Promise<boolean> => {
      const b = this.builders.get(id);
      if (!b) return true;
      const gen = b.handler(this.project);
      let res = await gen.next();
      while (!res.done) {
        const u = res.value;
        await stores.updates.setUpdate({ signal: u.signal, uri: u.uri, stamp: u.stamp });
        res = await gen.next();
      }
      return res.value !== false;
    };

    const stages = this.executionOrder(graph).filter((c) => c !== SCAN_CELL);
    const only = opts?.builders ? new Set(opts.builders) : undefined;
    const active = only ? stages.filter((c) => only.has(c)) : stages;
    const log = loggerOf(this.project, "ProjectBuilder");
    log.info("build run started", { stages: active });

    try {
      // Safety backstop: abort if scheduling makes no progress for this many
      // consecutive passes. A pass is progress when a stage drains, handles at least
      // one update, or a scan surfaces work — so this scales to any corpus size
      // (including the batched scanner's many small transactions) while still
      // catching a genuinely stuck builder (never draining, or throwing before it
      // handles anything). A non-convergent build would otherwise loop forever.
      const maxStalledPasses = this.yieldConfig.maxStalledPasses;
      let stalled = 0;
      let converged = false;
      for (;;) {
        const frontier = await this.frontier(stores, graph);
        // Most-downstream stage behind the frontier whose producers are all at the
        // frontier — safe to bring up to date (its input is fully produced).
        const target = await this.nextStage(stores, graph, active, frontier);
        if (target) {
          const progressed = yield* this.advanceStage(
            stores,
            graph,
            runBuilder,
            target,
            frontier,
            errors,
            log,
          );
          stalled = progressed ? 0 : stalled + 1;
          if (stalled >= maxStalledPasses) {
            // No progress for `maxStalledPasses` passes: the most-downstream stages
            // (e.g. index reorganize / search) may never have run, leaving their
            // top-level artifacts unwritten. Surface it loudly, not as a clean build.
            log.error("build run stalled — no scheduling progress", {
              maxStalledPasses,
              stage: target,
            });
            errors.push(
              new Error(
                `ProjectBuilder.run: no scheduling progress for ${maxStalledPasses} ` +
                  `consecutive passes (stuck at "${target}"); a builder is not draining ` +
                  "its input or repeatedly throws",
              ),
            );
            break;
          }
          continue;
        }
        // Every stage is at the frontier. In explicit-builders mode we are done;
        // otherwise scan — advancing the frontier iff the scan surfaced new work.
        if (only) {
          converged = true;
          break;
        }
        if (!(yield* this.scanStage(stores, errors, log))) {
          converged = true;
          break;
        }
        stalled = 0; // a scan that surfaced work is progress
      }
      if (converged) log.info("build run converged");
    } finally {
      await this.flush(stores);
    }

    if (errors.length > 0) throw errors[0];
  }

  /** Full topological execution order, the prober(s) first. */
  private executionOrder(graph: DataflowGraph): string[] {
    const probers = graph.getAllCells().filter((c) => graph.getCellInputs(c).length === 0);
    const proberOutputs = new Set<SignalName>();
    for (const p of probers) for (const out of graph.getCellOutputs(p)) proberOutputs.add(out);
    return [...probers, ...graph.getExecutionOrder(proberOutputs)];
  }

  /** Count of unhandled updates across `cell`'s input signals. */
  private async pendingCount(stores: Stores, graph: DataflowGraph, cell: string): Promise<number> {
    let n = 0;
    for await (const _ of readCellUpdates(stores.updates, graph, cell)) n++;
    return n;
  }

  /** The latest transaction across all cells — the frontier convergence target. */
  private async frontier(stores: Stores, graph: DataflowGraph): Promise<number> {
    let max = 0;
    for (const cell of graph.getAllCells()) {
      const tx = await stores.transactions.getCellTransaction(cell);
      if (tx > max) max = tx;
    }
    return max;
  }

  /** Cells producing any of `cell`'s input signals. */
  private producers(graph: DataflowGraph, cell: string): string[] {
    const inputs = new Set(graph.getCellInputs(cell));
    return graph.getAllCells().filter((c) => graph.getCellOutputs(c).some((s) => inputs.has(s)));
  }

  /**
   * The most-downstream stage that is behind the frontier and whose producers have
   * all reached it — so running it to completion safely brings it up to date.
   */
  private async nextStage(
    stores: Stores,
    graph: DataflowGraph,
    stages: string[],
    frontier: number,
  ): Promise<string | undefined> {
    let target: string | undefined;
    for (const cell of stages) {
      if ((await stores.transactions.getCellTransaction(cell)) >= frontier) continue;
      let ready = true;
      for (const p of this.producers(graph, cell)) {
        if ((await stores.transactions.getCellTransaction(p)) < frontier) {
          ready = false;
          break;
        }
      }
      if (ready) target = cell;
    }
    return target;
  }

  /**
   * Run one stage toward the frontier. A handler that interrupts (`false`) leaves
   * work pending and keeps its old transaction, to be re-selected next pass; once
   * it has drained its input it is recorded at the frontier — even if it handled
   * nothing — keeping transaction ids monotonic. State is flushed on each advance.
   * Returns whether the stage made progress (drained, or handled ≥1 update) — the
   * scheduler's stall backstop relies on this to tell a working build from a stuck one.
   */
  private async *advanceStage(
    stores: Stores,
    graph: DataflowGraph,
    runBuilder: (id: string) => Promise<boolean>,
    cellId: string,
    frontier: number,
    errors: unknown[],
    log: Logger,
  ): AsyncGenerator<BuildProgress, boolean> {
    yield { type: "begin", transactionId: frontier };
    log.debug("advancing stage", { stage: cellId, frontier });
    const before = await this.pendingCount(stores, graph, cellId);
    let finished = false;
    try {
      finished = await runBuilder(cellId);
    } catch (error) {
      log.error("stage failed", { stage: cellId, error });
      errors.push(error);
    }
    const after = await this.pendingCount(stores, graph, cellId);
    const drained = after === 0;
    if (drained) await stores.transactions.setCellTransaction(cellId, frontier);
    await this.flush(stores);
    const result = finished || drained;
    log.info("stage", { stage: cellId, result: result ? "ok" : "interrupted", tx: frontier });
    yield { type: "call", transactionId: frontier, builderId: cellId, result };
    yield { type: "end", transactionId: frontier };
    // No producer runs during this stage, so `after <= before`; a strict decrease
    // means it handled at least one update this pass (partial progress).
    return drained || after < before;
  }

  /**
   * Run the scanner under a fresh transaction. Advances the frontier (records the
   * scanner at the new transaction) only if the scan emitted at least one update.
   */
  private async *scanStage(
    stores: Stores,
    errors: unknown[],
    log: Logger,
  ): AsyncGenerator<BuildProgress, boolean> {
    const transactionId = await stores.transactions.newTransactionId();
    yield { type: "begin", transactionId };
    let emitted = false;
    try {
      emitted = await this.scan(stores, transactionId);
    } catch (error) {
      log.error("scan failed", { error });
      errors.push(error);
    }
    if (emitted) await stores.transactions.setCellTransaction(SCAN_CELL, transactionId);
    await this.flush(stores);
    log.info(emitted ? "scan detected changes" : "scan: no changes", { tx: transactionId });
    yield { type: "end", transactionId };
    return emitted;
  }

  /** Per-builder pending counts and last-run transaction ids. */
  async status(): Promise<BuildStatus> {
    const stores = await this.ensureStores();
    const graph = this.getGraph();
    const builders = [];
    for (const b of this.builders.values()) {
      let pending = 0;
      for await (const _ of readCellUpdates(stores.updates, graph, b.id)) pending++;
      builders.push({
        id: b.id,
        pending,
        lastTransaction: await stores.transactions.getCellTransaction(b.id),
      });
    }
    return {
      nextTransactionId: stores.transactions.peekNextTransactionId(),
      builders,
    };
  }

  /**
   * Reset `builderId` and every builder downstream of it (by signal dependency):
   * clear their handled watermarks and transaction watermarks so the next `run()`
   * re-derives them. Upstream builders are untouched.
   */
  async restartFrom(builderId: string): Promise<void> {
    const stores = await this.ensureStores();
    const graph = this.getGraph();
    const affected = new Set(graph.getExecutionOrderFromCells([builderId]));
    affected.add(builderId);
    for (const cell of affected) {
      for (const signal of graph.getCellInputs(cell)) {
        await stores.updates.clearHandled({ signal, cell });
      }
      await stores.transactions.removeCellTransactions(cell);
    }
    await this.flush(stores);
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Generic mtime change-detection: emit `sources` / `sources-removed`. Returns
   * whether it emitted any update (i.e. whether the source set changed).
   *
   * When `scanBatchSize > 0` only that many changed sources are emitted per scan
   * (in uri order); the rest keep their stale mtime in `scannerState` and are
   * re-detected on the next scan, so each batch flows through the full pipeline
   * before the next is picked up. The full tree is always walked so removals are
   * detected regardless of the batch limit.
   */
  private async scan(stores: Stores, transactionId: number): Promise<boolean> {
    const { updates, scannerState } = stores;
    let emitted = false;
    const base = this.project.path.replace(/^\/+|\/+$/g, "");
    // `.projectignore` (gitignore-style) at the project root: excluded paths are
    // skipped here, so they never enter `seen` and any previously-indexed ones are
    // emitted as `sources-removed` below — adding a rule prunes their artifacts.
    const projectIgnore = makeProjectIgnore(
      await tryReadText(this.filesApi, joinPath(this.project.path, ".projectignore")),
    );
    // Compose `.projectignore` with the nature-supplied ignore (re-read each scan).
    const natureIgnore = this.sourceIgnore ? await this.sourceIgnore() : undefined;
    const isIgnored = (uri: string) => projectIgnore(uri) || (natureIgnore?.(uri) ?? false);
    const seen = new Set<string>();
    const changed: { uri: string; mtime: number }[] = [];
    for await (const info of this.filesApi.list(this.project.path, {
      recursive: true,
    })) {
      if (info.kind !== "file") continue;
      const uri = this.toProjectUri(info.path, base);
      if (uri === undefined) continue;
      // Skip dot-segments (system folder `.project/`, manifests, `.git`, …).
      if (uri.split("/").some((seg) => seg.startsWith("."))) continue;
      if (isIgnored(uri)) continue;
      seen.add(uri);
      const mtime = (info as { lastModified?: number }).lastModified ?? 0;
      const prev = scannerState.get(uri);
      if (prev !== undefined && prev === mtime) continue;
      changed.push({ uri, mtime });
    }
    // Emit at most `scanBatchSize` changed sources (0 = unlimited), in uri order so
    // the batch boundary is deterministic; un-emitted ones are re-detected next scan.
    const limit = this.yieldConfig.scanBatchSize;
    changed.sort((a, b) => a.uri.localeCompare(b.uri));
    for (const { uri, mtime } of limit > 0 ? changed.slice(0, limit) : changed) {
      await updates.setUpdate({ signal: SOURCES_SIGNAL, uri, stamp: transactionId });
      scannerState.set(uri, mtime);
      emitted = true;
    }
    for (const uri of [...scannerState.keys()]) {
      if (seen.has(uri)) continue;
      await updates.setUpdate({
        signal: SOURCES_REMOVED_SIGNAL,
        uri,
        stamp: transactionId,
      });
      scannerState.delete(uri);
      emitted = true;
    }
    return emitted;
  }

  /** Map a filesystem path under the project to a project-relative bare URI. */
  private toProjectUri(fsPath: string, base: string): string | undefined {
    const p = fsPath.replace(/^\/+/, "");
    if (base === "") return p;
    if (p === base) return undefined;
    if (!p.startsWith(`${base}/`)) return undefined;
    return p.slice(base.length + 1);
  }

  private async flush(stores: Stores): Promise<void> {
    await stores.updates.flush();
    await stores.transactions.flush();
    await writeJsonAtomic(
      this.filesApi,
      stores.scannerPath,
      Object.fromEntries(stores.scannerState),
    );
  }
}
