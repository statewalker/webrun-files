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
});
