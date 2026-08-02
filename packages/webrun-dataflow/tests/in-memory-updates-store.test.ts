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
    await store.setUpdate({ signal: "files", uri: "f1", stamp: 5 });
    const got = await collect(store.readEntries({ signal: "files", since: 0 }));
    expect(got).toEqual([{ signal: "files", uri: "f1", stamp: 5 }]);
  });

  it("yielded entries have exactly { signal, uri, stamp } and the queried signal", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "files", uri: "f1", stamp: 1 });
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
    await store.setUpdates([
      { signal: "x", uri: "a", stamp: 5 },
      { signal: "x", uri: "b", stamp: 7 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 5 }));
    expect(got).toEqual([{ signal: "x", uri: "b", stamp: 7 }]);
  });

  it("`since = 0` yields all entries", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
      { signal: "x", uri: "c", stamp: 3 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got.map((e) => e.stamp)).toEqual([1, 2, 3]);
  });

  it("`since` larger than any stamp yields nothing", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 10 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 1000 }));
    expect(got).toEqual([]);
  });

  it("`uriPrefix` selects only entries whose uri starts with the prefix", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "files", uri: "/a/1", stamp: 1 },
      { signal: "files", uri: "/a/2", stamp: 2 },
      { signal: "files", uri: "/b/1", stamp: 3 },
    ]);
    const got = await collect(store.readEntries({ signal: "files", since: 0, uriPrefix: "/a/" }));
    expect(got.map((e) => e.uri).sort()).toEqual(["/a/1", "/a/2"]);
  });

  it("empty `uriPrefix` is equivalent to no filter", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
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
    await store.setUpdate({ signal: "x", uri: "c", stamp: 9 });
    await store.setUpdate({ signal: "x", uri: "a", stamp: 3 });
    await store.setUpdate({ signal: "x", uri: "b", stamp: 5 });
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
    await store.setUpdates([
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
    await store.setUpdate({ signal: "x", uri: "a", stamp: 3 });
    await store.setUpdate({ signal: "x", uri: "a", stamp: 7 });
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got).toEqual([{ signal: "x", uri: "a", stamp: 7 }]);
  });

  it("second save with smaller stamp also wins (blind replace, no monotonicity)", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "x", uri: "a", stamp: 7 });
    await store.setUpdate({ signal: "x", uri: "a", stamp: 3 });
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got).toEqual([{ signal: "x", uri: "a", stamp: 3 }]);
  });

  it("saves on different signals do not interfere", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "x", uri: "a", stamp: 1 });
    await store.setUpdate({ signal: "y", uri: "a", stamp: 2 });
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([
      { signal: "x", uri: "a", stamp: 1 },
    ]);
    expect(await collect(store.readEntries({ signal: "y", since: 0 }))).toEqual([
      { signal: "y", uri: "a", stamp: 2 },
    ]);
  });

  it("saves on different URIs of the same signal do not interfere", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "x", uri: "a", stamp: 1 });
    await store.setUpdate({ signal: "x", uri: "b", stamp: 2 });
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got.map((e) => [e.uri, e.stamp])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});

describe("InMemoryUpdatesStore — deletion (with cascade)", () => {
  it("removeUpdate removes an existing row", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "x", uri: "a", stamp: 5 });
    await store.removeUpdate({ signal: "x", uri: "a" });
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([]);
  });

  it("removeUpdate on a non-existent key is a no-op (does not throw)", async () => {
    const store = new InMemoryUpdatesStore();
    await expect(store.removeUpdate({ signal: "x", uri: "never" })).resolves.toBeUndefined();
    await expect(
      store.removeUpdate({ signal: "never-seen", uri: "anything" }),
    ).resolves.toBeUndefined();
  });

  it("removeUpdate is local — does not affect other update keys", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
      { signal: "y", uri: "a", stamp: 3 },
    ]);
    await store.removeUpdate({ signal: "x", uri: "a" });
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([
      { signal: "x", uri: "b", stamp: 2 },
    ]);
    expect(await collect(store.readEntries({ signal: "y", since: 0 }))).toEqual([
      { signal: "y", uri: "a", stamp: 3 },
    ]);
  });

  it("removeUpdate cascades: clears every cell's handled row for (signal, uri)", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "s", uri: "u", stamp: 5 });
    await store.handleUpdate({ signal: "s", uri: "u", cell: "c1", stamp: 5 });
    await store.handleUpdate({ signal: "s", uri: "u", cell: "c2", stamp: 5 });

    await store.removeUpdate({ signal: "s", uri: "u" });
    await store.setUpdate({ signal: "s", uri: "u", stamp: 9 });

    expect(await collect(store.readUpdates({ signal: "s", cell: "c1" }))).toEqual([
      { signal: "s", uri: "u", stamp: 9 },
    ]);
    expect(await collect(store.readUpdates({ signal: "s", cell: "c2" }))).toEqual([
      { signal: "s", uri: "u", stamp: 9 },
    ]);
  });

  it("cascade does not touch other URIs' handled rows", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "s", uri: "u1", stamp: 5 },
      { signal: "s", uri: "u2", stamp: 5 },
    ]);
    await store.handleUpdate({ signal: "s", uri: "u1", cell: "c", stamp: 5 });
    await store.handleUpdate({ signal: "s", uri: "u2", cell: "c", stamp: 5 });

    await store.removeUpdate({ signal: "s", uri: "u1" });

    // u2 still handled by c → not yielded.
    expect(await collect(store.readUpdates({ signal: "s", cell: "c" }))).toEqual([]);
  });
});

describe("InMemoryUpdatesStore — batch operations", () => {
  it("setUpdates applies every entry", async () => {
    const store = new InMemoryUpdatesStore();
    const entries: UpdateEntry[] = [
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
    ];
    await store.setUpdates(entries);
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got).toEqual(entries);
  });

  it("removeUpdates removes every listed key", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "x", uri: "a", stamp: 1 },
      { signal: "x", uri: "b", stamp: 2 },
      { signal: "x", uri: "c", stamp: 3 },
    ]);
    await store.removeUpdates([
      { signal: "x", uri: "a" },
      { signal: "x", uri: "b" },
    ]);
    expect(await collect(store.readEntries({ signal: "x", since: 0 }))).toEqual([
      { signal: "x", uri: "c", stamp: 3 },
    ]);
  });

  it("handleUpdates marks every (signal, uri, cell) handled", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "s", uri: "a", stamp: 1 },
      { signal: "s", uri: "b", stamp: 1 },
    ]);
    await store.handleUpdates([
      { signal: "s", uri: "a", cell: "c", stamp: 1 },
      { signal: "s", uri: "b", cell: "c", stamp: 1 },
    ]);
    expect(await collect(store.readUpdates({ signal: "s", cell: "c" }))).toEqual([]);
  });
});

describe("InMemoryUpdatesStore — handleUpdate / per-cell isolation", () => {
  it("two cells handle the same (signal, uri) independently", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "file-source", uri: "/a.pdf", stamp: 8 });

    await store.handleUpdate({ signal: "file-source", uri: "/a.pdf", cell: "extract", stamp: 8 });

    expect(await collect(store.readUpdates({ signal: "file-source", cell: "extract" }))).toEqual(
      [],
    );
    expect(await collect(store.readUpdates({ signal: "file-source", cell: "preview" }))).toEqual([
      { signal: "file-source", uri: "/a.pdf", stamp: 8 },
    ]);
    // The raw update row is untouched.
    expect(await collect(store.readEntries({ signal: "file-source", since: 0 }))).toEqual([
      { signal: "file-source", uri: "/a.pdf", stamp: 8 },
    ]);
  });

  it("recording handled state never alters update rows / does not leak into readEntries", async () => {
    const store = new InMemoryUpdatesStore();
    await store.handleUpdate({ signal: "s", uri: "u", cell: "c", stamp: 1 });
    expect(await collect(store.readEntries({ signal: "s", since: 0 }))).toEqual([]);
  });

  it("accepts arbitrary signal/cell strings (spaces, delimiters) and round-trips them", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "a b", uri: "u", stamp: 1 });
    await store.handleUpdate({ signal: "a b", uri: "u", cell: "x y", stamp: 1 });
    expect(await collect(store.readUpdates({ signal: "a b", cell: "x y" }))).toEqual([]);
    expect(await collect(store.readUpdates({ signal: "a b", cell: "other" }))).toEqual([
      { signal: "a b", uri: "u", stamp: 1 },
    ]);
  });

  it("rejects a non-finite handled stamp", async () => {
    const store = new InMemoryUpdatesStore();
    await expect(
      store.handleUpdate({ signal: "s", uri: "u", cell: "c", stamp: Number.NaN }),
    ).rejects.toThrow(/finite|NaN|stamp/i);
  });
});

describe("InMemoryUpdatesStore — clearHandled (per-cell watermark reset)", () => {
  it("clears one cell's handled rows for a signal; the cell re-sees all updates", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "s", uri: "a", stamp: 5 },
      { signal: "s", uri: "b", stamp: 6 },
    ]);
    await store.handleUpdate({ signal: "s", uri: "a", cell: "c", stamp: 5 });
    await store.handleUpdate({ signal: "s", uri: "b", cell: "c", stamp: 6 });
    expect(await collect(store.readUpdates({ signal: "s", cell: "c" }))).toEqual([]);

    const removed = await store.clearHandled({ signal: "s", cell: "c" });
    expect(removed).toBe(2);
    expect(await collect(store.readUpdates({ signal: "s", cell: "c" }))).toEqual([
      { signal: "s", uri: "a", stamp: 5 },
      { signal: "s", uri: "b", stamp: 6 },
    ]);
  });

  it("does not touch update rows or other cells' handled state", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "s", uri: "a", stamp: 5 });
    await store.handleUpdate({ signal: "s", uri: "a", cell: "c1", stamp: 5 });
    await store.handleUpdate({ signal: "s", uri: "a", cell: "c2", stamp: 5 });

    await store.clearHandled({ signal: "s", cell: "c1" });

    // Update row intact.
    expect(await collect(store.readEntries({ signal: "s", since: 0 }))).toEqual([
      { signal: "s", uri: "a", stamp: 5 },
    ]);
    // c1 reset, c2 untouched.
    expect(await collect(store.readUpdates({ signal: "s", cell: "c1" }))).toEqual([
      { signal: "s", uri: "a", stamp: 5 },
    ]);
    expect(await collect(store.readUpdates({ signal: "s", cell: "c2" }))).toEqual([]);
  });

  it("returns 0 when the cell has no handled rows for the signal", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "s", uri: "a", stamp: 5 });
    expect(await store.clearHandled({ signal: "s", cell: "never" })).toBe(0);
    expect(await store.clearHandled({ signal: "missing", cell: "c" })).toBe(0);
  });
});

describe("InMemoryUpdatesStore — readUpdates (per-cell diff)", () => {
  it("yields every update when the cell has handled nothing", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src", uri: "a", stamp: 1 },
      { signal: "src", uri: "b", stamp: 2 },
    ]);
    const got = await collect(store.readUpdates({ signal: "src", cell: "ext" }));
    expect(got).toEqual([
      { signal: "src", uri: "a", stamp: 1 },
      { signal: "src", uri: "b", stamp: 2 },
    ]);
  });

  it("skips URIs where the cell's handled stamp >= update stamp", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src", uri: "a", stamp: 5 },
      { signal: "src", uri: "b", stamp: 7 },
    ]);
    await store.handleUpdate({ signal: "src", uri: "a", cell: "ext", stamp: 5 }); // caught up
    await store.handleUpdate({ signal: "src", uri: "b", cell: "ext", stamp: 6 }); // lagging
    const got = await collect(store.readUpdates({ signal: "src", cell: "ext" }));
    expect(got).toEqual([{ signal: "src", uri: "b", stamp: 7 }]);
  });

  it("URI present only as handled state (no update row) is not yielded", async () => {
    const store = new InMemoryUpdatesStore();
    await store.handleUpdate({ signal: "src", uri: "a", cell: "ext", stamp: 3 });
    const got = await collect(store.readUpdates({ signal: "src", cell: "ext" }));
    expect(got).toEqual([]);
  });

  it("yields entries in update-stamp-ascending order by default", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src", uri: "c", stamp: 9 },
      { signal: "src", uri: "a", stamp: 3 },
      { signal: "src", uri: "b", stamp: 5 },
    ]);
    const got = await collect(store.readUpdates({ signal: "src", cell: "ext" }));
    expect(got.map((e) => e.stamp)).toEqual([3, 5, 9]);
  });

  it("orderBy: 'uri' yields URI-ascending", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src", uri: "z", stamp: 1 },
      { signal: "src", uri: "a", stamp: 9 },
      { signal: "src", uri: "m", stamp: 5 },
    ]);
    const got = await collect(store.readUpdates({ signal: "src", cell: "ext", orderBy: "uri" }));
    expect(got.map((e) => e.uri)).toEqual(["a", "m", "z"]);
  });

  it("uriPrefix restricts to URIs whose path matches the prefix", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src", uri: "/a/1", stamp: 1 },
      { signal: "src", uri: "/a/2", stamp: 2 },
      { signal: "src", uri: "/b/1", stamp: 3 },
    ]);
    const got = await collect(store.readUpdates({ signal: "src", cell: "ext", uriPrefix: "/a/" }));
    expect(got.map((e) => e.uri).sort()).toEqual(["/a/1", "/a/2"]);
  });

  it("yields nothing when the signal has no update rows", async () => {
    const store = new InMemoryUpdatesStore();
    await store.handleUpdate({ signal: "ext", uri: "a", cell: "c", stamp: 1 });
    const got = await collect(store.readUpdates({ signal: "never-emitted", cell: "c" }));
    expect(got).toEqual([]);
  });

  it("after the cell handles a yielded update, the URI no longer appears", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "src", uri: "a", stamp: 5 });

    const first = await collect(store.readUpdates({ signal: "src", cell: "ext" }));
    expect(first).toEqual([{ signal: "src", uri: "a", stamp: 5 }]);

    await store.handleUpdate({ signal: "src", uri: "a", cell: "ext", stamp: 5 });

    const second = await collect(store.readUpdates({ signal: "src", cell: "ext" }));
    expect(second).toEqual([]);
  });

  it("a newer update after handling reappears", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "src", uri: "a", stamp: 5 });
    await store.handleUpdate({ signal: "src", uri: "a", cell: "ext", stamp: 5 });
    expect(await collect(store.readUpdates({ signal: "src", cell: "ext" }))).toEqual([]);

    await store.setUpdate({ signal: "src", uri: "a", stamp: 9 });
    expect(await collect(store.readUpdates({ signal: "src", cell: "ext" }))).toEqual([
      { signal: "src", uri: "a", stamp: 9 },
    ]);
  });

  it("empty uriPrefix is equivalent to no prefix", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src", uri: "a", stamp: 1 },
      { signal: "src", uri: "b", stamp: 2 },
    ]);
    const withEmpty = await collect(
      store.readUpdates({ signal: "src", cell: "ext", uriPrefix: "" }),
    );
    const without = await collect(store.readUpdates({ signal: "src", cell: "ext" }));
    expect(withEmpty).toEqual(without);
  });
});

describe("InMemoryUpdatesStore — JSON round-trip (two relations)", () => {
  it("new InMemoryUpdatesStore(prev.snapshot()) preserves updates and handled state", async () => {
    const prev = new InMemoryUpdatesStore();
    await prev.setUpdates([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
      { signal: "content", uri: "f1", stamp: 3 },
    ]);
    await prev.handleUpdate({ signal: "files", uri: "f1", cell: "c", stamp: 1 });

    const next = new InMemoryUpdatesStore(prev.snapshot());

    expect(await collect(next.readEntries({ signal: "files", since: 0 }))).toEqual(
      await collect(prev.readEntries({ signal: "files", since: 0 })),
    );
    // handled state survived: f1 handled by c, f2 not.
    expect(await collect(next.readUpdates({ signal: "files", cell: "c" }))).toEqual([
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
    expect(await collect(next.readUpdates({ signal: "files", cell: "other" }))).toEqual([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
  });

  it("JSON.parse(JSON.stringify(store)) round-trips updates and handled through the constructor", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
    await store.handleUpdate({ signal: "files", uri: "f1", cell: "c", stamp: 1 });
    const blob = JSON.stringify(store);
    const restored = new InMemoryUpdatesStore(JSON.parse(blob));
    expect(await collect(restored.readEntries({ signal: "files", since: 0 }))).toEqual([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
    expect(await collect(restored.readUpdates({ signal: "files", cell: "c" }))).toEqual([
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
  });

  it("constructor accepts a legacy flat snapshot (updates-only) as updates", async () => {
    const legacy = { files: { f1: 1, f2: 2 } } as unknown as SerializedUpdatesStore;
    const store = new InMemoryUpdatesStore(legacy);
    expect(await collect(store.readEntries({ signal: "files", since: 0 }))).toEqual([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
  });

  it("constructor defensively copies initialState — mutating input does not affect store", async () => {
    const state: SerializedUpdatesStore = {
      updates: { files: { f1: 1, f2: 2 } },
      handled: {},
    };
    const store = new InMemoryUpdatesStore(state);
    const filesIn = state.updates.files;
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
    await store.setUpdates([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
    const snap = store.snapshot();
    const filesOut = snap.updates.files;
    if (!filesOut) throw new Error("unreachable — files just saved");
    delete filesOut.f1;
    filesOut.f2 = 999;
    const got = await collect(store.readEntries({ signal: "files", since: 0 }));
    expect(got).toEqual([
      { signal: "files", uri: "f1", stamp: 1 },
      { signal: "files", uri: "f2", stamp: 2 },
    ]);
  });

  it("snapshot() of an empty store has empty updates and handled", async () => {
    const store = new InMemoryUpdatesStore();
    expect(store.snapshot()).toEqual({ updates: {}, handled: {} });
  });

  it("removeUpdate-emptied signal is absent from snapshot()", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "x", uri: "a", stamp: 1 });
    await store.removeUpdate({ signal: "x", uri: "a" });
    expect(store.snapshot()).toEqual({ updates: {}, handled: {} });
  });

  it("preserves entries whose signal or uri is '__proto__' through serialization", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "__proto__", uri: "f1", stamp: 5 });
    await store.setUpdate({ signal: "files", uri: "__proto__", stamp: 9 });

    const snap = store.snapshot();
    const proto = snap.updates.__proto__;
    if (!proto) throw new Error("expected __proto__ signal in snapshot");
    expect(proto.f1).toBe(5);

    const files = snap.updates.files;
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

describe("InMemoryUpdatesStore — orderBy 'stamp' vs 'uri'", () => {
  it("readEntries defaults to stamp-ascending order", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "x", uri: "c", stamp: 9 },
      { signal: "x", uri: "a", stamp: 3 },
      { signal: "x", uri: "b", stamp: 5 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 0 }));
    expect(got.map((e) => e.uri)).toEqual(["a", "b", "c"]);
    expect(got.map((e) => e.stamp)).toEqual([3, 5, 9]);
  });

  it("readEntries with orderBy: 'uri' yields URI-ascending regardless of stamp", async () => {
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "x", uri: "b", stamp: 9 },
      { signal: "x", uri: "a", stamp: 100 },
      { signal: "x", uri: "c", stamp: 1 },
    ]);
    const got = await collect(store.readEntries({ signal: "x", since: 0, orderBy: "uri" }));
    expect(got.map((e) => e.uri)).toEqual(["a", "b", "c"]);
    expect(got.map((e) => e.stamp)).toEqual([100, 9, 1]);
  });
});

describe("InMemoryUpdatesStore — stamp validation", () => {
  it("rejects a NaN stamp instead of storing an unreadable entry", async () => {
    const store = new InMemoryUpdatesStore();
    await expect(store.setUpdate({ signal: "x", uri: "a", stamp: Number.NaN })).rejects.toThrow(
      /finite|NaN|stamp/i,
    );
  });

  it("rejects a non-finite stamp (Infinity) for the same reason", async () => {
    const store = new InMemoryUpdatesStore();
    await expect(
      store.setUpdate({ signal: "x", uri: "a", stamp: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/finite|stamp/i);
  });
});
