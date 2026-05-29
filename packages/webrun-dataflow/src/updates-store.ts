import type { Signal } from "./types.js";

/**
 * A single update entry: "the URI `uri` was changed on signal `signal` at
 * transaction stamp `stamp`". Pure pointer — no payload. The data the URI
 * addresses lives in the caller's domain store.
 */
export interface UpdateEntry {
  signal: Signal;
  uri: string;
  stamp: number;
}

/**
 * JSON-safe serialization shape for an `UpdatesStore`. Outer key = signal,
 * inner = uri → latest stamp. Accepted by `InMemoryUpdatesStore`'s constructor
 * and returned by `snapshot()` / `toJSON()`.
 */
export type SerializedUpdatesStore = {
  [signal: string]: { [uri: string]: number };
};

/**
 * Per-`(signal, uri)` updates log used by handlers driving multi-stage
 * dataflow pipelines. Sits alongside `TransactionStore` and `DataflowGraph`
 * as a leaf of `@statewalker/shared-dataflow`.
 *
 * Semantics:
 *
 * - Upsert by `(signal, uri)`: each save overwrites the previous stamp for
 *   that pair. No history is retained.
 * - Stamps are caller-supplied. The store does NOT derive, validate, or
 *   compare stamps — saves blindly replace, including with smaller stamps.
 * - `readEntries` is exclusive on `since` (`stamp > since`), yields entries
 *   in stamp-ascending order, and optionally filters by `uriPrefix`.
 * - Deletion is two-stage: the caller propagates a tombstone signal through
 *   the dataflow graph (a convention, not enforced by the store), and the
 *   tombstone-consuming handler calls `removeEntry` to erase both the
 *   original row and the tombstone row.
 *
 * Caller responsibilities not enforced by the store: stamp discipline,
 * signal naming consistency with any `DataflowGraph` topology, tombstone
 * naming conventions.
 */
export interface UpdatesStore {
  /**
   * Read entries on a signal whose stamp > `since`, optionally filtered by
   * URI prefix. Yields full `UpdateEntry` objects in stamp-ascending order.
   *
   * - `since` is exclusive: `stamp > since`. Use `since = 0` to read everything.
   * - `uriPrefix` (optional, defaults to no filter) restricts to entries whose
   *   `uri.startsWith(uriPrefix)`. An empty string is treated as no filter.
   */
  readEntries(opts: {
    signal: Signal;
    since: number;
    uriPrefix?: string;
  }): AsyncIterable<UpdateEntry>;

  /**
   * Per-URI cell-to-cell diff: yields upstream entries the current cell
   * hasn't caught up to yet. For each URI present in `upstreamSignal`,
   * comparing its stamp to the same URI's stamp under `currentSignal`:
   *
   * - upstream stamp > current stamp (or current absent → treated as 0):
   *   yielded.
   * - upstream stamp <= current stamp: NOT yielded — current cell is
   *   already caught up.
   *
   * URIs that exist only under `currentSignal` (upstream has no entry)
   * are NEVER yielded: the upstream either never saw the URI or has
   * since cleaned it up via tombstone, so the current cell has nothing
   * to do.
   *
   * Yields in upstream-stamp-ascending order. `uriPrefix` filters the
   * same way as `readEntries`.
   *
   * Caller contract: after handling a yielded entry, save a
   * `currentSignal` entry with stamp >= the yielded upstream stamp to
   * advance the per-URI watermark. Otherwise the URI appears again on
   * the next call.
   */
  readUpdatedEntries(opts: {
    upstreamSignal: Signal;
    currentSignal: Signal;
    uriPrefix?: string;
  }): AsyncIterable<UpdateEntry>;

  /** Upsert by `(signal, uri)`. Replaces blindly — last write wins. */
  saveEntry(entry: UpdateEntry): Promise<void>;
  /** Sequential equivalent of `entries.forEach(saveEntry)`. No atomicity promise. */
  saveEntries(entries: ReadonlyArray<UpdateEntry>): Promise<void>;

  /**
   * Remove the entry identified by `(signal, uri)`. Used by tombstone-
   * consuming handlers to clean up after a deletion has propagated.
   * No-op if the entry does not exist.
   */
  removeEntry(key: { signal: Signal; uri: string }): Promise<void>;
  /** Sequential equivalent of `keys.forEach(removeEntry)`. No atomicity promise. */
  removeEntries(keys: ReadonlyArray<{ signal: Signal; uri: string }>): Promise<void>;
}
