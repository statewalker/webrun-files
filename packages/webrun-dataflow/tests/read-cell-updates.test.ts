import { describe, expect, it } from "vitest";
import { DataflowGraph } from "../src/dataflow-graph.js";
import { InMemoryUpdatesStore } from "../src/in-memory-updates-store.js";
import { aggregateByUri, readCellUpdates } from "../src/read-cell-updates.js";
import type { UpdateEntry } from "../src/updates-store.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("readCellUpdates — graph-driven per-cell unhandled diff", () => {
  it("yields the updates on a single upstream signal the cell hasn't handled", async () => {
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "sources", uri: "a", stamp: 1 },
      { signal: "sources", uri: "b", stamp: 3 },
    ]);
    await store.handleUpdate({ signal: "sources", uri: "a", cell: "Extractor", stamp: 1 });
    const got = await collect(readCellUpdates(store, graph, "Extractor"));
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
    await store.setUpdates([
      { signal: "sources:removed", uri: "a", stamp: 5 },
      { signal: "meta:removed-topics", uri: "a#topicX", stamp: 7 },
    ]);
    const got = await collect(readCellUpdates(store, graph, "Pruner"));
    expect(got).toEqual([
      { signal: "sources:removed", uri: "a", stamp: 5 },
      { signal: "meta:removed-topics", uri: "a#topicX", stamp: 7 },
    ]);
  });

  it("yields the same URI multiple times when it's fresh in multiple upstream signals", async () => {
    const graph = new DataflowGraph([
      { id: "FanIn", inputs: ["src-a", "src-b"], outputs: ["fan-out"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src-a", uri: "shared", stamp: 1 },
      { signal: "src-b", uri: "shared", stamp: 2 },
    ]);
    const got = await collect(readCellUpdates(store, graph, "FanIn"));
    expect(got).toEqual([
      { signal: "src-a", uri: "shared", stamp: 1 },
      { signal: "src-b", uri: "shared", stamp: 2 },
    ]);
  });

  it("respects per-cell watermark — URIs the cell handled on each input are excluded", async () => {
    const graph = new DataflowGraph([
      { id: "FanIn", inputs: ["src-a", "src-b"], outputs: ["fan-out"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src-a", uri: "x", stamp: 5 },
      { signal: "src-b", uri: "x", stamp: 7 },
    ]);
    await store.handleUpdate({ signal: "src-a", uri: "x", cell: "FanIn", stamp: 5 });
    await store.handleUpdate({ signal: "src-b", uri: "x", cell: "FanIn", stamp: 7 });
    const got = await collect(readCellUpdates(store, graph, "FanIn"));
    expect(got).toEqual([]);
  });

  it("yields nothing for a prober cell (no inputs)", async () => {
    const graph = new DataflowGraph([{ id: "Scanner", inputs: [], outputs: ["sources"] }]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "sources", uri: "a", stamp: 1 });
    const got = await collect(readCellUpdates(store, graph, "Scanner"));
    expect(got).toEqual([]);
  });

  it("works for a sink cell (inputs, no outputs) — yields and does NOT throw", async () => {
    const graph = new DataflowGraph([{ id: "Index", inputs: ["content"], outputs: [] }]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "content", uri: "u", stamp: 2 });
    const got = await collect(readCellUpdates(store, graph, "Index"));
    expect(got).toEqual([{ signal: "content", uri: "u", stamp: 2 }]);
  });

  it("two cells consuming the same input track handled state independently", async () => {
    const graph = new DataflowGraph([
      { id: "Extract", inputs: ["file-source"], outputs: ["content"] },
      { id: "Preview", inputs: ["file-source"], outputs: [] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "file-source", uri: "/a.pdf", stamp: 8 });
    await store.handleUpdate({ signal: "file-source", uri: "/a.pdf", cell: "Extract", stamp: 8 });

    expect(await collect(readCellUpdates(store, graph, "Extract"))).toEqual([]);
    expect(await collect(readCellUpdates(store, graph, "Preview"))).toEqual([
      { signal: "file-source", uri: "/a.pdf", stamp: 8 },
    ]);
  });

  it("uriPrefix filters every upstream signal consistently", async () => {
    const graph = new DataflowGraph([
      { id: "FanIn", inputs: ["src-a", "src-b"], outputs: ["fan-out"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src-a", uri: "/keep/1", stamp: 1 },
      { signal: "src-a", uri: "/drop/1", stamp: 2 },
      { signal: "src-b", uri: "/keep/1", stamp: 3 },
      { signal: "src-b", uri: "/drop/2", stamp: 4 },
    ]);
    const got = await collect(readCellUpdates(store, graph, "FanIn", { uriPrefix: "/keep/" }));
    expect(got.map((e) => [e.signal, e.uri])).toEqual([
      ["src-a", "/keep/1"],
      ["src-b", "/keep/1"],
    ]);
  });

  it("merges entries from all upstream signals into a single URI-sorted stream", async () => {
    const graph = new DataflowGraph([
      { id: "FanIn", inputs: ["src-a", "src-b", "src-c"], outputs: ["fan-out"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src-a", uri: "z", stamp: 1 },
      { signal: "src-a", uri: "m", stamp: 9 },
      { signal: "src-b", uri: "a", stamp: 2 },
      { signal: "src-b", uri: "z", stamp: 3 },
      { signal: "src-c", uri: "m", stamp: 4 },
    ]);
    const got = await collect(readCellUpdates(store, graph, "FanIn"));
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
      { id: "FanIn", inputs: ["src-z", "src-a"], outputs: ["fan-out"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src-a", uri: "u", stamp: 1 },
      { signal: "src-z", uri: "u", stamp: 2 },
    ]);
    const got = await collect(readCellUpdates(store, graph, "FanIn"));
    expect(got.map((e) => e.signal)).toEqual(["src-z", "src-a"]);
  });

  it("yields nothing for an unknown cell id", async () => {
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdate({ signal: "sources", uri: "a", stamp: 1 });
    const got = await collect(readCellUpdates(store, graph, "Unknown"));
    expect(got).toEqual([]);
  });

  it("an upstream signal with no entries contributes nothing but the next upstream still flows", async () => {
    const graph = new DataflowGraph([
      { id: "FanIn", inputs: ["empty-src", "live-src"], outputs: ["fan-out"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "live-src", uri: "a", stamp: 1 },
      { signal: "live-src", uri: "b", stamp: 2 },
    ]);
    const got = await collect(readCellUpdates(store, graph, "FanIn"));
    expect(got).toEqual([
      { signal: "live-src", uri: "a", stamp: 1 },
      { signal: "live-src", uri: "b", stamp: 2 },
    ]);
  });

  it("incrementally handling URIs monotonically shrinks the diff", async () => {
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "sources", uri: "a", stamp: 1 },
      { signal: "sources", uri: "b", stamp: 2 },
      { signal: "sources", uri: "c", stamp: 3 },
    ]);

    expect((await collect(readCellUpdates(store, graph, "Extractor"))).map((e) => e.uri)).toEqual([
      "a",
      "b",
      "c",
    ]);

    await store.handleUpdate({ signal: "sources", uri: "a", cell: "Extractor", stamp: 1 });
    expect((await collect(readCellUpdates(store, graph, "Extractor"))).map((e) => e.uri)).toEqual([
      "b",
      "c",
    ]);

    await store.handleUpdate({ signal: "sources", uri: "b", cell: "Extractor", stamp: 2 });
    expect((await collect(readCellUpdates(store, graph, "Extractor"))).map((e) => e.uri)).toEqual([
      "c",
    ]);

    await store.handleUpdate({ signal: "sources", uri: "c", cell: "Extractor", stamp: 3 });
    expect(await collect(readCellUpdates(store, graph, "Extractor"))).toEqual([]);
  });

  it("does not pre-buffer: the consumer can break early without draining all upstream entries", async () => {
    let reads = 0;
    const inner = new InMemoryUpdatesStore();
    await inner.setUpdates([
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
        if (prop === "readUpdates") {
          return async function* (
            this: unknown,
            ...args: Parameters<typeof inner.readUpdates>
          ): AsyncIterable<UpdateEntry> {
            for await (const e of inner.readUpdates(...args)) {
              reads += 1;
              yield e;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const graph = new DataflowGraph([
      { id: "FanIn", inputs: ["src-a", "src-b"], outputs: ["fan-out"] },
    ]);

    let firstUri: string | undefined;
    for await (const entry of readCellUpdates(spyStore, graph, "FanIn")) {
      firstUri = entry.uri;
      break;
    }
    expect(firstUri).toBe("a-00");
    expect(reads).toBeLessThan(20);
  });

  it("scales: 100 URIs across 3 upstream signals merge into a single URI-sorted stream", async () => {
    const graph = new DataflowGraph([
      { id: "Big", inputs: ["src-a", "src-b", "src-c"], outputs: ["consolidated"] },
    ]);
    const store = new InMemoryUpdatesStore();
    const expected: string[] = [];
    for (let i = 0; i < 100; i++) {
      const uri = `u-${String(i).padStart(3, "0")}`;
      expected.push(uri);
      const signal = ["src-a", "src-b", "src-c"][i % 3] as string;
      await store.setUpdate({ signal, uri, stamp: ((i * 17) % 97) + 1 });
    }
    const got = await collect(readCellUpdates(store, graph, "Big"));
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

  it("composes with readCellUpdates to give one record per URI across upstream signals", async () => {
    const graph = new DataflowGraph([
      { id: "FanIn", inputs: ["src-a", "src-b"], outputs: ["fan-out"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "src-a", uri: "x", stamp: 1 },
      { signal: "src-b", uri: "x", stamp: 2 },
      { signal: "src-a", uri: "y", stamp: 3 },
    ]);
    const got = await aggregateByUri(readCellUpdates(store, graph, "FanIn"));
    expect([...got.keys()].sort()).toEqual(["x", "y"]);
    expect(got.get("x")?.map((e) => e.signal)).toEqual(["src-a", "src-b"]);
    expect(got.get("y")?.map((e) => e.signal)).toEqual(["src-a"]);
  });
});

describe("readCellUpdates — multi-cell pipeline integration", () => {
  it("propagates per-URI state through a 3-stage pipeline and reaches an empty-diff equilibrium", async () => {
    // Pipeline:  sources → Extractor (extracted) → Summarizer (summarized) → MetaExtractor (meta)
    const graph = new DataflowGraph([
      { id: "Extractor", inputs: ["sources"], outputs: ["extracted"] },
      { id: "Summarizer", inputs: ["extracted"], outputs: ["summarized"] },
      { id: "MetaExtractor", inputs: ["summarized"], outputs: ["meta"] },
    ]);
    const store = new InMemoryUpdatesStore();
    await store.setUpdates([
      { signal: "sources", uri: "doc-a", stamp: 1 },
      { signal: "sources", uri: "doc-b", stamp: 2 },
    ]);

    // Sweep helper: each cell handles every yielded input update (advances
    // its per-cell watermark) and announces the same stamp on its output
    // signal so the next cell sees it.
    async function sweepOnce(): Promise<Record<string, string[]>> {
      const processed: Record<string, string[]> = {};
      for (const cellId of ["Extractor", "Summarizer", "MetaExtractor"]) {
        const list: string[] = [];
        const output = graph.getCellOutputs(cellId)[0] as string;
        for await (const entry of readCellUpdates(store, graph, cellId)) {
          list.push(entry.uri);
          await store.handleUpdate({
            signal: entry.signal,
            uri: entry.uri,
            cell: cellId,
            stamp: entry.stamp,
          });
          await store.setUpdate({ signal: output, uri: entry.uri, stamp: entry.stamp });
        }
        processed[cellId] = list;
      }
      return processed;
    }

    const first = await sweepOnce();
    expect(first.Extractor).toEqual(["doc-a", "doc-b"]);
    expect(first.Summarizer).toEqual(["doc-a", "doc-b"]);
    expect(first.MetaExtractor).toEqual(["doc-a", "doc-b"]);

    const second = await sweepOnce();
    expect(second).toEqual({ Extractor: [], Summarizer: [], MetaExtractor: [] });

    // Restamp a single source file. The cascade re-fires for that URI only.
    await store.setUpdate({ signal: "sources", uri: "doc-a", stamp: 9 });
    const third = await sweepOnce();
    expect(third).toEqual({
      Extractor: ["doc-a"],
      Summarizer: ["doc-a"],
      MetaExtractor: ["doc-a"],
    });

    const fourth = await sweepOnce();
    expect(fourth).toEqual({ Extractor: [], Summarizer: [], MetaExtractor: [] });
  });
});
