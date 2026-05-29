import type { Signal } from "./types.js";
import type {
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

/**
 * In-memory `UpdatesStore` reference implementation. State lives in this
 * process; nothing is persisted across restarts. Suitable for tests and
 * single-process pipelines.
 *
 * State is held as `Map<Signal, Map<Uri, Stamp>>`. The constructor accepts
 * (and `snapshot()` / `toJSON()` return) a `SerializedUpdatesStore` — a plain
 * JSON-safe nested object. Both directions are defensively copied: the store
 * never holds a live reference to caller-provided objects, and the snapshot
 * returned to a caller can be mutated freely without affecting the store.
 */
export class InMemoryUpdatesStore implements UpdatesStore {
  private readonly state = new Map<Signal, Map<string, number>>();

  constructor(initialState?: SerializedUpdatesStore) {
    if (!initialState) return;
    for (const [signal, signalRows] of Object.entries(initialState)) {
      const inner = new Map<string, number>();
      for (const [uri, stamp] of Object.entries(signalRows)) {
        inner.set(uri, stamp);
      }
      if (inner.size > 0) this.state.set(signal, inner);
    }
  }

  async saveEntry(entry: UpdateEntry): Promise<void> {
    if (!Number.isFinite(entry.stamp)) {
      throw new Error(
        `InMemoryUpdatesStore.saveEntry: stamp must be a finite number, got ${entry.stamp}`,
      );
    }
    let inner = this.state.get(entry.signal);
    if (!inner) {
      inner = new Map<string, number>();
      this.state.set(entry.signal, inner);
    }
    inner.set(entry.uri, entry.stamp);
  }

  async saveEntries(entries: ReadonlyArray<UpdateEntry>): Promise<void> {
    for (const entry of entries) await this.saveEntry(entry);
  }

  async removeEntry(key: { signal: Signal; uri: string }): Promise<void> {
    const inner = this.state.get(key.signal);
    if (!inner) return;
    inner.delete(key.uri);
    if (inner.size === 0) this.state.delete(key.signal);
  }

  async removeEntries(keys: ReadonlyArray<{ signal: Signal; uri: string }>): Promise<void> {
    for (const key of keys) await this.removeEntry(key);
  }

  async *readEntries(opts: {
    signal: Signal;
    since: number;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry> {
    const inner = this.state.get(opts.signal);
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

  async *readUpdatedEntries(opts: {
    upstreamSignal: Signal;
    currentSignal: Signal;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry> {
    const upstream = this.state.get(opts.upstreamSignal);
    if (!upstream) return;
    const current = this.state.get(opts.currentSignal);
    const prefix = opts.uriPrefix ?? "";
    const matches: Array<[string, number]> = [];
    for (const [uri, upstreamStamp] of upstream) {
      if (prefix !== "" && !uri.startsWith(prefix)) continue;
      const currentStamp = current?.get(uri) ?? 0;
      if (upstreamStamp > currentStamp) matches.push([uri, upstreamStamp]);
    }
    matches.sort(compareMatches(opts.orderBy));
    for (const [uri, stamp] of matches) {
      yield { signal: opts.upstreamSignal, uri, stamp };
    }
  }

  /**
   * Return a fresh JSON-safe snapshot of the store's state. Mutating the
   * returned object does not affect the store.
   */
  snapshot(): SerializedUpdatesStore {
    // Plain `obj[key] = ...` invokes the __proto__ setter for that key,
    // silently dropping entries whose signal or uri is "__proto__". Use
    // defineProperty so any string is stored as an own enumerable property.
    const out = {} as SerializedUpdatesStore;
    for (const [signal, inner] of this.state) {
      const signalRows = {} as { [uri: string]: number };
      for (const [uri, stamp] of inner) {
        Object.defineProperty(signalRows, uri, {
          value: stamp,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      Object.defineProperty(out, signal, {
        value: signalRows,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }

  /** Makes `JSON.stringify(store)` produce a valid `SerializedUpdatesStore` JSON string. */
  toJSON(): SerializedUpdatesStore {
    return this.snapshot();
  }
}
