import { describe, expect, it } from "vitest";
import { DataflowGraph } from "../src/dataflow-graph.js";
import { InMemoryUpdatesStore } from "../src/in-memory-updates-store.js";
import { aggregateByUri, readUpstreamChanges } from "../src/read-upstream-changes.js";
import type { UpdateEntry } from "../src/updates-store.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("readUpstreamChanges — graph-driven per-cell upstream diff", () => {
  it("yields the diff between a single upstream signal and the cell's first output", async () => {
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "sources", uri: "a", stamp: 1 },
      { signal: "sources", uri: "b", stamp: 3 },
      { signal: "extracted", uri: "a", stamp: 1 }, // caught up
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "Extractor"));
    expect(got).toEqual([{ signal: "sources", uri: "b", stamp: 3 }]);
  });

  it("yields entries from every upstream signal of the cell", async () => {
    const graph = new DataflowGraph([
      {
        id: "Pruner",
        inputs: ["sources:removed", "meta:removed-topics"],
        outputs: ["pruned"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "sources:removed", uri: "a", stamp: 5 },
      { signal: "meta:removed-topics", uri: "a#topicX", stamp: 7 },
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "Pruner"));
    expect(got).toEqual([
      { signal: "sources:removed", uri: "a", stamp: 5 },
      { signal: "meta:removed-topics", uri: "a#topicX", stamp: 7 },
    ]);
  });

  it("yields the same URI multiple times when it's fresh in multiple upstream signals", async () => {
    const graph = new DataflowGraph([
      {
        id: "FanIn",
        inputs: ["src-a", "src-b"],
        outputs: ["fan-out"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "src-a", uri: "shared", stamp: 1 },
      { signal: "src-b", uri: "shared", stamp: 2 },
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "FanIn"));
    expect(got).toEqual([
      { signal: "src-a", uri: "shared", stamp: 1 },
      { signal: "src-b", uri: "shared", stamp: 2 },
    ]);
  });

  it("respects per-URI watermark — URIs caught up by the cell's first output are excluded", async () => {
    const graph = new DataflowGraph([
      {
        id: "FanIn",
        inputs: ["src-a", "src-b"],
        outputs: ["fan-out"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "src-a", uri: "x", stamp: 5 },
      { signal: "src-b", uri: "x", stamp: 7 },
      { signal: "fan-out", uri: "x", stamp: 7 }, // caught up to the max
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "FanIn"));
    expect(got).toEqual([]);
  });

  it("yields nothing for a prober cell (no inputs)", async () => {
    const graph = new DataflowGraph([{ id: "Scanner", inputs: [], outputs: ["sources"] }]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "sources", uri: "a", stamp: 1 });
    const got = await collect(readUpstreamChanges(store, graph, "Scanner"));
    expect(got).toEqual([]);
  });

  it("throws if the cell has inputs but no outputs (no watermark)", async () => {
    const graph = new DataflowGraph([{ id: "Terminal", inputs: ["sources"], outputs: [] }]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "sources", uri: "a", stamp: 1 });
    await expect(collect(readUpstreamChanges(store, graph, "Terminal"))).rejects.toThrow(
      /no outputs|watermark/i,
    );
  });

  it("uses the FIRST declared output as the watermark signal", async () => {
    // MetaExtractor-style cell: primary cascade output is "meta",
    // secondary is "meta:removed-topics" (tombstones, not a watermark).
    const graph = new DataflowGraph([
      {
        id: "MetaExtractor",
        inputs: ["summarized"],
        outputs: ["meta", "meta:removed-topics"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "summarized", uri: "a", stamp: 3 },
      { signal: "meta", uri: "a", stamp: 3 }, // caught up via primary output
      // meta:removed-topics intentionally stays empty
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "MetaExtractor"));
    expect(got).toEqual([]);
  });

  it("uriPrefix filters every upstream signal consistently", async () => {
    const graph = new DataflowGraph([
      {
        id: "FanIn",
        inputs: ["src-a", "src-b"],
        outputs: ["fan-out"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "src-a", uri: "/keep/1", stamp: 1 },
      { signal: "src-a", uri: "/drop/1", stamp: 2 },
      { signal: "src-b", uri: "/keep/1", stamp: 3 },
      { signal: "src-b", uri: "/drop/2", stamp: 4 },
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "FanIn", { uriPrefix: "/keep/" }));
    expect(got.map((e) => [e.signal, e.uri])).toEqual([
      ["src-a", "/keep/1"],
      ["src-b", "/keep/1"],
    ]);
  });

  it("merges entries from all upstream signals into a single URI-sorted stream", async () => {
    const graph = new DataflowGraph([
      {
        id: "FanIn",
        inputs: ["src-a", "src-b", "src-c"],
        outputs: ["fan-out"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      // Deliberately mix URIs across signals and stamps so neither
      // per-signal stamp order nor signal-declaration order alone
      // produces the URI-sorted result.
      { signal: "src-a", uri: "z", stamp: 1 },
      { signal: "src-a", uri: "m", stamp: 9 },
      { signal: "src-b", uri: "a", stamp: 2 },
      { signal: "src-b", uri: "z", stamp: 3 },
      { signal: "src-c", uri: "m", stamp: 4 },
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "FanIn"));
    expect(got.map((e) => [e.uri, e.signal])).toEqual([
      ["a", "src-b"],
      ["m", "src-a"],
      ["m", "src-c"],
      ["z", "src-a"],
      ["z", "src-b"],
    ]);
  });

  it("breaks URI ties by signal-declaration order (graph.getCellInputs)", async () => {
    const graph = new DataflowGraph([
      {
        id: "FanIn",
        // Declared order matters: src-z is listed FIRST, src-a SECOND.
        inputs: ["src-z", "src-a"],
        outputs: ["fan-out"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "src-a", uri: "u", stamp: 1 },
      { signal: "src-z", uri: "u", stamp: 2 },
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "FanIn"));
    expect(got.map((e) => e.signal)).toEqual(["src-z", "src-a"]);
  });

  it("yields nothing for an unknown cell id", async () => {
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntry({ signal: "sources", uri: "a", stamp: 1 });
    const got = await collect(readUpstreamChanges(store, graph, "Unknown"));
    expect(got).toEqual([]);
  });

  it("an upstream signal with no entries contributes nothing but the next upstream still flows", async () => {
    const graph = new DataflowGraph([
      {
        id: "FanIn",
        inputs: ["empty-src", "live-src"],
        outputs: ["fan-out"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "live-src", uri: "a", stamp: 1 },
      { signal: "live-src", uri: "b", stamp: 2 },
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "FanIn"));
    expect(got).toEqual([
      { signal: "live-src", uri: "a", stamp: 1 },
      { signal: "live-src", uri: "b", stamp: 2 },
    ]);
  });

  it("a cell whose first output also appears as an upstream input self-cancels for that signal", async () => {
    // Pathological but legal: `cycle-self` is both an input and the
    // primary output. The watermark equals one of the upstream signals,
    // so its diff is empty. The other upstream still contributes.
    const graph = new DataflowGraph([
      {
        id: "SelfLoop",
        inputs: ["other-src", "cycle-self"],
        outputs: ["cycle-self"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "cycle-self", uri: "a", stamp: 5 },
      { signal: "other-src", uri: "b", stamp: 7 },
    ]);
    const got = await collect(readUpstreamChanges(store, graph, "SelfLoop"));
    expect(got).toEqual([{ signal: "other-src", uri: "b", stamp: 7 }]);
  });

  it("incrementally saving watermark entries monotonically shrinks the diff", async () => {
    // Simulates the cell-handler loop: read upstream changes, process
    // one URI, save the current-signal watermark, observe the diff
    // shrink.
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "sources", uri: "a", stamp: 1 },
      { signal: "sources", uri: "b", stamp: 2 },
      { signal: "sources", uri: "c", stamp: 3 },
    ]);

    expect(
      (await collect(readUpstreamChanges(store, graph, "Extractor"))).map((e) => e.uri),
    ).toEqual(["a", "b", "c"]);

    await store.saveEntry({ signal: "extracted", uri: "a", stamp: 1 });
    expect(
      (await collect(readUpstreamChanges(store, graph, "Extractor"))).map((e) => e.uri),
    ).toEqual(["b", "c"]);

    await store.saveEntry({ signal: "extracted", uri: "b", stamp: 2 });
    expect(
      (await collect(readUpstreamChanges(store, graph, "Extractor"))).map((e) => e.uri),
    ).toEqual(["c"]);

    await store.saveEntry({ signal: "extracted", uri: "c", stamp: 3 });
    expect(await collect(readUpstreamChanges(store, graph, "Extractor"))).toEqual([]);
  });

  it("does not pre-buffer: the consumer can break early without draining all upstream entries", async () => {
    // Verifies the streaming k-way merge: if the consumer breaks after
    // the first entry, the underlying per-signal iterators should be
    // closed without yielding the rest. We assert this by spying on a
    // store wrapper that counts how many entries were read per
    // upstream signal.
    let reads = 0;
    const inner = new InMemoryUpdatesStore();
    await inner.saveEntries([
      // Two upstream signals, 10 entries each.
      ...Array.from({ length: 10 }, (_, i) => ({
        signal: "src-a",
        uri: `a-${String(i).padStart(2, "0")}`,
        stamp: i + 1,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        signal: "src-b",
        uri: `b-${String(i).padStart(2, "0")}`,
        stamp: i + 1,
      })),
    ]);

    const spyStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "readUpdatedEntries") {
          return async function* (
            this: unknown,
            ...args: Parameters<typeof inner.readUpdatedEntries>
          ): AsyncIterable<UpdateEntry> {
            for await (const e of inner.readUpdatedEntries(...args)) {
              reads += 1;
              yield e;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const graph = new DataflowGraph([
      {
        id: "FanIn",
        inputs: ["src-a", "src-b"],
        outputs: ["fan-out"],
      },
    ]);

    let firstUri: string | undefined;
    for await (const entry of readUpstreamChanges(spyStore, graph, "FanIn")) {
      firstUri = entry.uri;
      break;
    }
    expect(firstUri).toBe("a-00");

    // Streaming merge primes one head per signal (2 reads) and yields
    // one entry. Without breaking, all 20 entries would be read; we
    // expect strictly fewer than 20 reads.
    expect(reads).toBeLessThan(20);
  });

  it("scales: 100 URIs across 3 upstream signals merge into a single URI-sorted stream", async () => {
    const graph = new DataflowGraph([
      {
        id: "Big",
        inputs: ["src-a", "src-b", "src-c"],
        outputs: ["consolidated"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    const expected: string[] = [];
    for (let i = 0; i < 100; i++) {
      const uri = `u-${String(i).padStart(3, "0")}`;
      expected.push(uri);
      // Each URI lands on exactly one of the three signals,
      // round-robin, with arbitrary stamps.
      const signal = ["src-a", "src-b", "src-c"][i % 3] as string;
      await store.saveEntry({
        signal,
        uri,
        stamp: ((i * 17) % 97) + 1,
      });
    }
    const got = await collect(readUpstreamChanges(store, graph, "Big"));
    expect(got).toHaveLength(100);
    expect(got.map((e) => e.uri)).toEqual(expected);
  });
});

describe("aggregateByUri — collapse multi-upstream entries per URI", () => {
  it("returns a Map keyed by URI with all contributing entries", async () => {
    const entries: UpdateEntry[] = [
      { signal: "src-a", uri: "x", stamp: 1 },
      { signal: "src-b", uri: "x", stamp: 2 },
      { signal: "src-a", uri: "y", stamp: 3 },
    ];
    async function* gen(): AsyncIterable<UpdateEntry> {
      for (const e of entries) yield e;
    }
    const got = await aggregateByUri(gen());
    expect(got.size).toBe(2);
    expect(got.get("x")).toEqual([
      { signal: "src-a", uri: "x", stamp: 1 },
      { signal: "src-b", uri: "x", stamp: 2 },
    ]);
    expect(got.get("y")).toEqual([{ signal: "src-a", uri: "y", stamp: 3 }]);
  });

  it("preserves source insertion order in the Map", async () => {
    const entries: UpdateEntry[] = [
      { signal: "s", uri: "b", stamp: 1 },
      { signal: "s", uri: "a", stamp: 2 },
      { signal: "s", uri: "c", stamp: 3 },
    ];
    async function* gen(): AsyncIterable<UpdateEntry> {
      for (const e of entries) yield e;
    }
    const got = await aggregateByUri(gen());
    expect([...got.keys()]).toEqual(["b", "a", "c"]);
  });

  it("returns an empty Map for an empty source", async () => {
    async function* gen(): AsyncIterable<UpdateEntry> {
      // no yields
    }
    const got = await aggregateByUri(gen());
    expect(got.size).toBe(0);
  });

  it("composes with readUpstreamChanges to give one record per URI across upstream signals", async () => {
    const graph = new DataflowGraph([
      {
        id: "FanIn",
        inputs: ["src-a", "src-b"],
        outputs: ["fan-out"],
      },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.saveEntries([
      { signal: "src-a", uri: "x", stamp: 1 },
      { signal: "src-b", uri: "x", stamp: 2 },
      { signal: "src-a", uri: "y", stamp: 3 },
    ]);
    const got = await aggregateByUri(readUpstreamChanges(store, graph, "FanIn"));
    expect([...got.keys()].sort()).toEqual(["x", "y"]);
    expect(got.get("x")?.map((e) => e.signal)).toEqual(["src-a", "src-b"]);
    expect(got.get("y")?.map((e) => e.signal)).toEqual(["src-a"]);
  });

  it("accumulates many entries for the same URI in arrival order within the bucket", async () => {
    const entries: UpdateEntry[] = [
      { signal: "s1", uri: "uri-1", stamp: 1 },
      { signal: "s2", uri: "uri-1", stamp: 2 },
      { signal: "s3", uri: "uri-1", stamp: 3 },
      { signal: "s4", uri: "uri-1", stamp: 4 },
    ];
    async function* gen(): AsyncIterable<UpdateEntry> {
      for (const e of entries) yield e;
    }
    const got = await aggregateByUri(gen());
    expect(got.size).toBe(1);
    expect(got.get("uri-1")).toEqual(entries);
  });
});

describe("readUpstreamChanges — multi-cell pipeline integration", () => {
  it("propagates per-URI watermarks through a 3-stage pipeline and reaches an empty-diff equilibrium", async () => {
    // Pipeline:  sources → Extractor (extracted) → Summarizer (summarized)
    //                                            → MetaExtractor (meta)
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
      { id: "Summarizer", inputs: ["extracted"], outputs: ["summarized"] },
      { id: "MetaExtractor", inputs: ["summarized"], outputs: ["meta"] },
    ]);
    const store = new InMemoryUpdatesStore();
    // Seed two source files.
    await store.saveEntries([
      { signal: "sources", uri: "doc-a", stamp: 1 },
      { signal: "sources", uri: "doc-b", stamp: 2 },
    ]);

    // Sweep helper: for every cell that still has upstream changes,
    // copy each yielded entry's stamp onto the cell's watermark
    // signal — i.e., advance the per-URI watermark to the upstream
    // stamp the cell just observed.
    async function sweepOnce(): Promise<Record<string, string[]>> {
      const processed: Record<string, string[]> = {};
      for (const cellId of ["Extractor", "Summarizer", "MetaExtractor"]) {
        const list: string[] = [];
        const watermark = graph.getCellOutputs(cellId)[0] as string;
        for await (const entry of readUpstreamChanges(store, graph, cellId)) {
          list.push(entry.uri);
          await store.saveEntry({
            signal: watermark,
            uri: entry.uri,
            stamp: entry.stamp,
          });
        }
        processed[cellId] = list;
      }
      return processed;
    }

    // First sweep: Extractor sees both source URIs and copies onto
    // `extracted`; Summarizer then sees them via the just-written
    // watermark; MetaExtractor sees them via Summarizer's; all caught
    // up by the end of the sweep.
    const first = await sweepOnce();
    expect(first.Extractor).toEqual(["doc-a", "doc-b"]);
    expect(first.Summarizer).toEqual(["doc-a", "doc-b"]);
    expect(first.MetaExtractor).toEqual(["doc-a", "doc-b"]);

    // Second sweep: every cell's per-URI watermark equals its upstream,
    // so the diff is empty everywhere. Equilibrium.
    const second = await sweepOnce();
    expect(second).toEqual({
      Extractor: [],
      Summarizer: [],
      MetaExtractor: [],
    });

    // Restamp a single source file (mtime bump). The cascade re-fires
    // for that URI only — every cell sees doc-a (and nothing else).
    await store.saveEntry({ signal: "sources", uri: "doc-a", stamp: 9 });
    const third = await sweepOnce();
    expect(third).toEqual({
      Extractor: ["doc-a"],
      Summarizer: ["doc-a"],
      MetaExtractor: ["doc-a"],
    });

    // Fourth sweep: back to equilibrium.
    const fourth = await sweepOnce();
    expect(fourth).toEqual({
      Extractor: [],
      Summarizer: [],
      MetaExtractor: [],
    });
  });
});
