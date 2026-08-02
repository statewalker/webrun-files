import type { Signal } from "./types.js";
import type {
  HandledEntry,
  ReadOrderBy,
  SerializedUpdatesStore,
  UpdateEntry,
  UpdatesStore,
} from "./updates-store.js";

function compareMatches(orderBy: ReadOrderBy | undefined) {
  if (orderBy === "uri") {
    return (a: [string, number], b: [string, number]) => {
      if (a[0] === b[0]) return 0;
      return a[0] < b[0] ? -1 : 1;
    };
  }
  return (a: [string, number], b: [string, number]) => a[1] - b[1];
}

function assertFiniteStamp(stamp: number, method: string): void {
  if (!Number.isFinite(stamp)) {
    throw new Error(`InMemoryUpdatesStore.${method}: stamp must be a finite number, got ${stamp}`);
  }
}

/**
 * `out[key] = value` invokes the `__proto__` setter for that key, silently
 * dropping entries whose key is "__proto__". `defineProperty` stores any
 * string as an own enumerable property so a snapshot/restore round-trip is
 * lossless and JSON-safe.
 */
function defineEnumerable<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isLegacyFlat(state: object): boolean {
  // The two-relation shape always carries an `updates` own-property. Anything
  // without it is a legacy flat `{ [signal]: { [uri]: number } }` snapshot.
  return !Object.hasOwn(state, "updates") && !Object.hasOwn(state, "handled");
}

/**
 * In-memory `UpdatesStore` reference implementation. State lives in this
 * process; nothing is persisted across restarts. Suitable for tests and
 * single-process pipelines.
 *
 * State is held as two maps mirroring the two logical relations:
 * `updates: Map<Signal, Map<Uri, Stamp>>` and
 * `handled: Map<Signal, Map<Cell, Map<Uri, Stamp>>>`.
 *
 * The constructor accepts (and `snapshot()` / `toJSON()` return) a
 * `SerializedUpdatesStore` — a plain JSON-safe object `{ updates, handled }`.
 * A legacy flat `{ [signal]: { [uri]: number } }` object is also accepted and
 * loaded as the `updates` relation (empty handled state). Both directions are
 * defensively copied: the store never holds a live reference to caller-provided
 * objects, and the snapshot returned to a caller can be mutated freely.
 */
export class InMemoryUpdatesStore implements UpdatesStore {
  private readonly updates = new Map<Signal, Map<string, number>>();
  private readonly handled = new Map<Signal, Map<string, Map<string, number>>>();

  constructor(initialState?: SerializedUpdatesStore) {
    if (!initialState) return;
    if (isLegacyFlat(initialState)) {
      const flat = initialState as unknown as { [signal: string]: { [uri: string]: number } };
      for (const [signal, rows] of Object.entries(flat)) {
        this.loadUpdates(signal, rows);
      }
      return;
    }
    for (const [signal, rows] of Object.entries(initialState.updates ?? {})) {
      this.loadUpdates(signal, rows);
    }
    for (const [signal, cells] of Object.entries(initialState.handled ?? {})) {
      for (const [cell, rows] of Object.entries(cells)) {
        for (const [uri, stamp] of Object.entries(rows)) {
          this.handledInner(signal, cell).set(uri, stamp);
        }
      }
    }
  }

  private loadUpdates(signal: string, rows: { [uri: string]: number }): void {
    const inner = new Map<string, number>();
    for (const [uri, stamp] of Object.entries(rows)) inner.set(uri, stamp);
    if (inner.size > 0) this.updates.set(signal, inner);
  }

  private handledInner(signal: Signal, cell: string): Map<string, number> {
    let cells = this.handled.get(signal);
    if (!cells) {
      cells = new Map<string, Map<string, number>>();
      this.handled.set(signal, cells);
    }
    let inner = cells.get(cell);
    if (!inner) {
      inner = new Map<string, number>();
      cells.set(cell, inner);
    }
    return inner;
  }

  async setUpdate(entry: UpdateEntry): Promise<void> {
    assertFiniteStamp(entry.stamp, "setUpdate");
    let inner = this.updates.get(entry.signal);
    if (!inner) {
      inner = new Map<string, number>();
      this.updates.set(entry.signal, inner);
    }
    inner.set(entry.uri, entry.stamp);
  }

  async setUpdates(entries: ReadonlyArray<UpdateEntry>): Promise<void> {
    for (const entry of entries) await this.setUpdate(entry);
  }

  async handleUpdate(entry: HandledEntry): Promise<void> {
    assertFiniteStamp(entry.stamp, "handleUpdate");
    this.handledInner(entry.signal, entry.cell).set(entry.uri, entry.stamp);
  }

  async handleUpdates(entries: ReadonlyArray<HandledEntry>): Promise<void> {
    for (const entry of entries) await this.handleUpdate(entry);
  }

  async clearHandled(key: { signal: Signal; cell: string }): Promise<number> {
    const cells = this.handled.get(key.signal);
    const inner = cells?.get(key.cell);
    if (!cells || !inner) return 0;
    const removed = inner.size;
    cells.delete(key.cell);
    if (cells.size === 0) this.handled.delete(key.signal);
    return removed;
  }

  async removeUpdate(key: { signal: Signal; uri: string }): Promise<void> {
    const inner = this.updates.get(key.signal);
    if (inner) {
      inner.delete(key.uri);
      if (inner.size === 0) this.updates.delete(key.signal);
    }
    // Cascade: drop this URI from every cell's handled map for the signal.
    const cells = this.handled.get(key.signal);
    if (cells) {
      for (const [cell, uris] of cells) {
        uris.delete(key.uri);
        if (uris.size === 0) cells.delete(cell);
      }
      if (cells.size === 0) this.handled.delete(key.signal);
    }
  }

  async removeUpdates(keys: ReadonlyArray<{ signal: Signal; uri: string }>): Promise<void> {
    for (const key of keys) await this.removeUpdate(key);
  }

  async *readEntries(opts: {
    signal: Signal;
    since: number;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry> {
    const inner = this.updates.get(opts.signal);
    if (!inner) return;
    const prefix = opts.uriPrefix ?? "";
    const matches: Array<[string, number]> = [];
    for (const [uri, stamp] of inner) {
      if (stamp > opts.since && (prefix === "" || uri.startsWith(prefix))) {
        matches.push([uri, stamp]);
      }
    }
    matches.sort(compareMatches(opts.orderBy));
    for (const [uri, stamp] of matches) {
      yield { signal: opts.signal, uri, stamp };
    }
  }

  async *readUpdates(opts: {
    signal: Signal;
    cell: string;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry> {
    const inner = this.updates.get(opts.signal);
    if (!inner) return;
    const handledByCell = this.handled.get(opts.signal)?.get(opts.cell);
    const prefix = opts.uriPrefix ?? "";
    const matches: Array<[string, number]> = [];
    for (const [uri, stamp] of inner) {
      if (prefix !== "" && !uri.startsWith(prefix)) continue;
      const handledStamp = handledByCell?.get(uri) ?? 0;
      if (stamp > handledStamp) matches.push([uri, stamp]);
    }
    matches.sort(compareMatches(opts.orderBy));
    for (const [uri, stamp] of matches) {
      yield { signal: opts.signal, uri, stamp };
    }
  }

  /**
   * Return a fresh JSON-safe snapshot of both relations. Mutating the
   * returned object does not affect the store.
   */
  snapshot(): SerializedUpdatesStore {
    const updates = {} as SerializedUpdatesStore["updates"];
    for (const [signal, inner] of this.updates) {
      const rows = {} as { [uri: string]: number };
      for (const [uri, stamp] of inner) defineEnumerable(rows, uri, stamp);
      defineEnumerable(updates, signal, rows);
    }
    const handled = {} as SerializedUpdatesStore["handled"];
    for (const [signal, cells] of this.handled) {
      const cellsOut = {} as { [cell: string]: { [uri: string]: number } };
      for (const [cell, inner] of cells) {
        const rows = {} as { [uri: string]: number };
        for (const [uri, stamp] of inner) defineEnumerable(rows, uri, stamp);
        defineEnumerable(cellsOut, cell, rows);
      }
      defineEnumerable(handled, signal, cellsOut);
    }
    return { updates, handled };
  }

  /** Makes `JSON.stringify(store)` produce a valid `SerializedUpdatesStore` JSON string. */
  toJSON(): SerializedUpdatesStore {
    return this.snapshot();
  }
}
