import { describe, expect, it } from "vitest";
import { InMemoryUpdatesStore } from "../src/in-memory-updates-store.js";
import type { SerializedUpdatesStore, UpdateEntry } from "../src/updates-store.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("InMemoryUpdatesStore — round-trip & shape", () => {
  it("yields a single saved entry back via readEntries", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "files", uri: "f1", stamp: 5 });
    const got = await collect(store.readEntries({ signal: "files", since: 0 }));
    expect(got).toEqual([{ signal: "files", uri: "f1", stamp: 5 }]);
  });

  it("yielded entries have exactly { signal, uri, stamp } and the queried signal", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "files", uri: "f1", stamp: 1 });
    const got = await collect(store.readEntries({ signal: "files", since: 0 }));
    expect(got).toHaveLength(1);
    const first = got[0];
    if (!first) throw new Error("unreachable — length asserted above");
    expect(Object.keys(first).sort()).toEqual(["signal", "stamp", "uri"]);
    expect(first.signal).toBe("files");
  });
});

describe("InMemoryUpdatesStore — readEntries filters", () => {
  it("`since` is exclusive — entries with stamp == since are not yielded", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "x", uri: "a", stamp: 5 },
      { signal: "x", uri: "b", stamp: 7 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 5 }));
    expect(got).toEqual([{ signal: "x", uri: "b", stamp: 7 }]);
  });

  it("`since = 0` yields all entries", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
      { signal: "x", uri: "c", stamp: 3 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got.map((e) => e.stamp)).toEqual([1, 2, 3]);
  });

  it("`since` larger than any stamp yields nothing", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 10 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 1000 }));
    expect(got).toEqual([]);
  });

  it("`uriPrefix` selects only entries whose uri starts with the prefix", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "files", uri: "/a/1", stamp: 1 },
      { signal: "files", uri: "/a/2", stamp: 2 },
      { signal: "files", uri: "/b/1", stamp: 3 },
    ]);
    const got = await collect(store.readEntries({ signal: "files", since: 0, uriPrefix: "/a/" }));
    expect(got.map((e) => e.uri).sort()).toEqual(["/a/1", "/a/2"]);
  });

  it("empty `uriPrefix` is equivalent to no filter", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
    ]);
    const withEmpty = await collect(store.readEntries({ signal: "x", since: 0, uriPrefix: "" }));
    const without = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(withEmpty).toEqual(without);
  });
});

describe("InMemoryUpdatesStore — readEntries ordering", () => {
  it("yields entries in stamp-ascending order regardless of save order", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "x", uri: "c", stamp: 9 });
    await store.saveEntry({ signal: "x", uri: "a", stamp: 3 });
    await store.saveEntry({ signal: "x", uri: "b", stamp: 5 });
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got.map((e) => e.stamp)).toEqual([3, 5, 9]);
  });
});

describe("InMemoryUpdatesStore — empty / unknown queries", () => {
  it("yields nothing for an unknown signal on an empty store, without throwing", async () => {
    const store = new InMemoryUpdatesStore();
    const got = await collect(store.readEntries({ signal: "never-seen", since: 0 }));
    expect(got).toEqual([]);
  });

  it("yields nothing for a known signal whose entries are all <= since", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 2 }));
    expect(got).toEqual([]);
  });
});

describe("InMemoryUpdatesStore — upsert blind replace", () => {
  it("second save with greater stamp wins", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "x", uri: "a", stamp: 3 });
    await store.saveEntry({ signal: "x", uri: "a", stamp: 7 });
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got).toEqual([{ signal: "x", uri: "a", stamp: 7 }]);
  });

  it("second save with smaller stamp also wins (blind replace, no monotonicity)", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "x", uri: "a", stamp: 7 });
    await store.saveEntry({ signal: "x", uri: "a", stamp: 3 });
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got).toEqual([{ signal: "x", uri: "a", stamp: 3 }]);
  });

  it("saves on different signals do not interfere", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "x", uri: "a", stamp: 1 });
    await store.saveEntry({ signal: "y", uri: "a", stamp: 2 });
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([
      { signal: "x", uri: "a", stamp: 1 },
    ]);
    expect(await collect(store.readEntries({ signal: "y", since: 0 }))).toEqual([
      { signal: "y", uri: "a", stamp: 2 },
    ]);
  });

  it("saves on different URIs of the same signal do not interfere", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "x", uri: "a", stamp: 1 });
    await store.saveEntry({ signal: "x", uri: "b", stamp: 2 });
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got.map((e) => [e.uri, e.stamp])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});

describe("InMemoryUpdatesStore — deletion", () => {
  it("removeEntry removes an existing row", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "x", uri: "a", stamp: 5 });
    await store.removeEntry({ signal: "x", uri: "a" });
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([]);
  });

  it("removeEntry on a non-existent key is a no-op (does not throw)", async () => {
    const store = new InMemoryUpdatesStore();
    await expect(store.removeEntry({ signal: "x", uri: "never" })).resolves.toBeUndefined();
    await expect(
      store.removeEntry({ signal: "never-seen", uri: "anything" }),
    ).resolves.toBeUndefined();
  });

  it("removeEntry is local — does not affect other keys", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
      { signal: "y", uri: "a", stamp: 3 },
    ]);
    await store.removeEntry({ signal: "x", uri: "a" });
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([
      { signal: "x", uri: "b", stamp: 2 },
    ]);
    expect(await collect(store.readEntries({ signal: "y", since: 0 }))).toEqual([
      { signal: "y", uri: "a", stamp: 3 },
    ]);
  });
});

describe("InMemoryUpdatesStore — batch operations", () => {
  it("saveEntries applies every entry", async () => {
    const store = new InMemoryUpdatesStore();
    const entries: UpdateEntry[] = [
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
    ];
    await store.saveEntries(entries);
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got).toEqual(entries);
  });

  it("removeEntries removes every listed key", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
      { signal: "x", uri: "c", stamp: 3 },
    ]);
    await store.removeEntries([
      { signal: "x", uri: "a" },
      { signal: "x", uri: "b" },
    ]);
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([
      { signal: "x", uri: "c", stamp: 3 },
    ]);
  });
});

describe("InMemoryUpdatesStore — JSON round-trip", () => {
  it("new InMemoryUpdatesStore(prev.snapshot()) preserves all entries", async () => {
    const prev = new InMemoryUpdatesStore();
    await prev.saveEntries([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
      { signal: "content", uri: "f1", stamp: 3 },
    ]);

    const next = new InMemoryUpdatesStore(prev.snapshot());

    expect(await collect(next.readEntries({ signal: "files", since: 0 }))).toEqual(
      await collect(prev.readEntries({ signal: "files", since: 0 })),
    );
    expect(await collect(next.readEntries({ signal: "content", since: 0 }))).toEqual(
      await collect(prev.readEntries({ signal: "content", since: 0 })),
    );
  });

  it("JSON.parse(JSON.stringify(store)) round-trips through the constructor", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
    const blob = JSON.stringify(store);
    const restored = new InMemoryUpdatesStore(JSON.parse(blob));
    expect(await collect(restored.readEntries({ signal: "files", since: 0 }))).toEqual([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
  });

  it("constructor defensively copies initialState — mutating input does not affect store", async () => {
    const state: SerializedUpdatesStore = { files: { f1: 1, f2: 2 } };
    const store = new InMemoryUpdatesStore(state);
    const filesIn = state.files;
    if (!filesIn) throw new Error("unreachable — set above");
    delete filesIn.f1;
    filesIn.f2 = 999;
    const got = await collect(store.readEntries({ signal: "files", since: 0 }));
    expect(got).toEqual([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
  });

  it("snapshot() returns a fresh object — mutating it does not affect store", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
    const snap = store.snapshot();
    const filesOut = snap.files;
    if (!filesOut) throw new Error("unreachable — files just saved");
    delete filesOut.f1;
    filesOut.f2 = 999;
    const got = await collect(store.readEntries({ signal: "files", since: 0 }));
    expect(got).toEqual([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
  });

  it("snapshot() of an empty store is an empty object (and stringifies to '{}')", async () => {
    const store = new InMemoryUpdatesStore();
    expect(store.snapshot()).toEqual({});
    expect(JSON.stringify(store)).toBe("{}");
  });

  it("removeEntry-emptied signal is absent from snapshot()", async () => {
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "x", uri: "a", stamp: 1 });
    await store.removeEntry({ signal: "x", uri: "a" });
    expect(store.snapshot()).toEqual({});
  });

  it("preserves entries whose signal or uri is '__proto__' through serialization", async () => {
    // Plain-object assignment via `out[signal] = ...` invokes the __proto__
    // setter for that key — silently dropping the entry from JSON output and
    // polluting the snapshot's prototype. The store must serialize these
    // keys as ordinary own properties so a snapshot/restore round-trip is
    // lossless and the snapshot is JSON-safe.
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "__proto__", uri: "f1", stamp: 5 });
    await store.saveEntry({ signal: "files", uri: "__proto__", stamp: 9 });

    const snap = store.snapshot();
    const proto = snap.__proto__;
    if (!proto) throw new Error("expected __proto__ signal in snapshot");
    expect(proto.f1).toBe(5);

    const files = snap.files;
    if (!files) throw new Error("expected files signal in snapshot");
    expect(files.__proto__).toBe(9);

    const blob = JSON.stringify(store);
    expect(blob).toContain("__proto__");
    const restored = new InMemoryUpdatesStore(JSON.parse(blob));
    expect(await collect(restored.readEntries({ signal: "__proto__", since: 0 }))).toEqual([
      { signal: "__proto__", uri: "f1", stamp: 5 },
    ]);
    expect(await collect(restored.readEntries({ signal: "files", since: 0 }))).toEqual([
      { signal: "files", uri: "__proto__", stamp: 9 },
    ]);
  });
});

describe("InMemoryUpdatesStore — stamp validation", () => {
  it("rejects a NaN stamp instead of storing an unreadable entry", async () => {
    // A NaN stamp would round-trip into the store but be invisible to
    // readEntries (since NaN > anything is false). Reject at the boundary.
    const store = new InMemoryUpdatesStore();
    await expect(store.saveEntry({ signal: "x", uri: "a", stamp: Number.NaN })).rejects.toThrow(
      /finite|NaN|stamp/i,
    );
  });

  it("rejects a non-finite stamp (Infinity) for the same reason", async () => {
    const store = new InMemoryUpdatesStore();
    await expect(
      store.saveEntry({ signal: "x", uri: "a", stamp: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/finite|stamp/i);
  });
});
