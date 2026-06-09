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
 * A single per-cell handled record: "cell `cell` has caught up to the update
 * `(signal, uri)` as of stamp `stamp`". The `stamp` is intended to be the
 * upstream update stamp the cell observed when it handled the change.
 */
export interface HandledEntry extends UpdateEntry {
  cell: string;
}

/**
 * JSON-safe serialization shape for an `UpdatesStore`. Two relations:
 *
 * - `updates` — outer key = signal, inner = uri → latest stamp.
 * - `handled` — outer key = signal, middle = cell, inner = uri → handled stamp.
 *
 * Accepted by `InMemoryUpdatesStore`'s constructor and returned by
 * `snapshot()` / `toJSON()`. This shape is **private** to `InMemoryUpdatesStore`
 * — it is NOT part of the `UpdatesStore` interface; a file-backed or database
 * store may persist however it likes.
 *
 * For backward compatibility the constructor also accepts a legacy flat
 * `{ [signal]: { [uri]: number } }` object (no `updates`/`handled` keys),
 * treating the whole object as the `updates` relation with empty handled state.
 */
export type SerializedUpdatesStore = {
  updates: { [signal: string]: { [uri: string]: number } };
  handled: { [signal: string]: { [cell: string]: { [uri: string]: number } } };
};

/**
 * Yield ordering for read methods on `UpdatesStore`. Both options yield
 * the same set of entries — only the order differs.
 *
 * - `"stamp"` (default) — last-transaction-id ascending. Best when the
 *   consumer wants temporal-order replay.
 * - `"uri"` — URI ascending. Best when the consumer wants to collapse
 *   per-URI work in one forward pass, or to merge multiple read streams
 *   by URI without buffering (see `readCellUpdates`).
 */
export type ReadOrderBy = "stamp" | "uri";

/**
 * Per-`(signal, uri)` updates log plus a per-cell handled dimension, used by
 * handlers driving multi-stage dataflow pipelines. Sits alongside
 * `TransactionStore` and `DataflowGraph` as a leaf of `@statewalker/shared-dataflow`.
 *
 * Two logical relations:
 *
 * - `updates(signal, uri) -> stamp` — written by `setUpdate`, read by
 *   `readEntries` / `readUpdates`. Upsert by `(signal, uri)`; last write wins;
 *   stamps are caller-supplied and never validated beyond finiteness.
 * - `handled(signal, cell, uri) -> stamp` — written by `handleUpdate`, consulted
 *   (never yielded) by `readUpdates`. Records how far a cell has caught up to a
 *   signal's updates, independently per cell.
 *
 * The interface is storage-agnostic: it references no key encoding, separator,
 * or serialization, so it maps 1:1 onto a relational store (two tables;
 * `readUpdates` = indexed left-join; `removeUpdate` = `ON DELETE CASCADE`).
 *
 * Caller responsibilities not enforced by the store: stamp discipline, signal
 * naming consistency with any `DataflowGraph` topology, tombstone naming
 * conventions.
 */
export interface UpdatesStore {
  /**
   * Read updates on a signal whose stamp > `since`, optionally filtered by
   * URI prefix. Yields full `UpdateEntry` objects.
   *
   * - `since` is exclusive: `stamp > since`. Use `since = 0` to read everything.
   * - `uriPrefix` (optional, defaults to no filter) restricts to entries whose
   *   `uri.startsWith(uriPrefix)`. An empty string is treated as no filter.
   * - `orderBy` (optional, default `"stamp"`) — see `ReadOrderBy`.
   */
  readEntries(opts: {
    signal: Signal;
    since: number;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry>;

  /**
   * Per-cell diff: yields the updates on `signal` that `cell` hasn't caught
   * up to yet. For each URI present on `signal`, comparing its update stamp
   * to that cell's handled stamp for the same URI:
   *
   * - update stamp > cell's handled stamp (or handled absent → treated as 0):
   *   yielded.
   * - update stamp <= cell's handled stamp: NOT yielded — the cell is already
   *   caught up.
   *
   * URIs that exist only as handled state (no update row) are NEVER yielded.
   *
   * Default order is update-stamp-ascending. Pass `orderBy: "uri"` for
   * URI-ascending order — used by `readCellUpdates` to merge several per-signal
   * streams in O(1) buffering. `uriPrefix` filters the same way as `readEntries`.
   *
   * Caller contract: after handling a yielded entry, call `handleUpdate` with
   * stamp >= the yielded update stamp to advance the per-URI watermark for this
   * cell. Otherwise the URI appears again on the next call.
   */
  readUpdates(opts: {
    signal: Signal;
    cell: string;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry>;

  /** Upsert an update by `(signal, uri)`. Replaces blindly — last write wins. */
  setUpdate(entry: UpdateEntry): Promise<void>;
  /** Sequential equivalent of `entries.forEach(setUpdate)`. No atomicity promise. */
  setUpdates(entries: ReadonlyArray<UpdateEntry>): Promise<void>;

  /**
   * Record that `cell` has handled the update `(signal, uri)` at `stamp`
   * (intended to be the upstream stamp the cell observed). Upsert by
   * `(signal, cell, uri)`; replaces blindly. Never touches `updates` rows.
   */
  handleUpdate(entry: HandledEntry): Promise<void>;
  /** Sequential equivalent of `entries.forEach(handleUpdate)`. No atomicity promise. */
  handleUpdates(entries: ReadonlyArray<HandledEntry>): Promise<void>;

  /**
   * Remove every handled row recorded by `cell` against `signal`, resetting
   * that cell's per-URI watermark for the signal so all of the signal's
   * updates re-appear in the cell's next `readUpdates`. Never touches
   * `updates` rows or any other cell's handled rows. Returns the number of
   * handled rows removed. Used by restart/reset flows.
   */
  clearHandled(key: { signal: Signal; cell: string }): Promise<number>;

  /**
   * Remove the update identified by `(signal, uri)`, AND cascade-remove every
   * cell's handled row for that same `(signal, uri)`. Used by tombstone-
   * consuming handlers to clean up after a deletion has propagated; the cascade
   * prevents a re-created URI from being masked by a stale handled stamp.
   * No-op if the update does not exist.
   */
  removeUpdate(key: { signal: Signal; uri: string }): Promise<void>;
  /** Sequential equivalent of `keys.forEach(removeUpdate)`. No atomicity promise. */
  removeUpdates(
    keys: ReadonlyArray<{ signal: Signal; uri: string }>,
  ): Promise<void>;
}
