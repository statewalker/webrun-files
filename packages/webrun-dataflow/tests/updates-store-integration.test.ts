import { describe, expect, it } from "vitest";
import { DataflowGraph } from "../src/dataflow-graph.js";
import { InMemoryTransactionStore } from "../src/in-memory-transaction-store.js";
import { InMemoryUpdatesStore } from "../src/in-memory-updates-store.js";
import { readCellUpdates } from "../src/read-cell-updates.js";
import type { CellHandler } from "../src/updates-manager.js";
import { UpdatesManager } from "../src/updates-manager.js";
import type { UpdatesStore } from "../src/updates-store.js";

// -----------------------------------------------------------------------------
// Test domain stores — what handlers actually mutate. The UpdatesStore only
// carries pointers; the data lives here.

interface FileRecord {
  body: string;
  updatedAt: number;
}
type FilesStore = Map<string, FileRecord>;
type ContentStore = Map<string, string>;
type ChunksStore = Map<string, string>;
type EmbeddingsStore = Map<string, number[]>;
type IndexStore = Map<string, { embedding: number[]; content: string }>;

// -----------------------------------------------------------------------------
// Handler factories. Each consumes via `readCellUpdates` (per-cell handled
// watermark), records consumption with `handleUpdate(input)`, and announces
// production with `setUpdate(output)` carrying the observed upstream stamp.

const graph = new DataflowGraph([
  { id: "FilesScanner", inputs: ["scan"], outputs: ["files"] },
  { id: "Extractor", inputs: ["files"], outputs: ["content"] },
  { id: "Chunker", inputs: ["content"], outputs: ["chunks"] },
  { id: "Embedder", inputs: ["chunks"], outputs: ["embeddings"] },
  { id: "Indexer", inputs: ["content", "chunks", "embeddings"], outputs: [] },
  { id: "ContentRemover", inputs: ["files:removed"], outputs: ["content:removed"] },
  { id: "ChunksRemover", inputs: ["content:removed"], outputs: ["chunks:removed"] },
  {
    id: "EmbeddingsRemover",
    inputs: ["chunks:removed"],
    outputs: ["embeddings:removed"],
  },
  { id: "IndexRemover", inputs: ["embeddings:removed"], outputs: [] },
]);

// Scanner — prober at the top. Its `scan` input never carries updates; it
// observes the files domain directly and stamps `files` with the activation tx.
function newFilesScanner(deps: { files: FilesStore; updatesStore: UpdatesStore }): CellHandler {
  const lastSeen = new Map<string, number>();
  return async ({ transactionId }) => {
    for (const [uri, file] of deps.files) {
      const seen = lastSeen.get(uri) ?? 0;
      if (file.updatedAt > seen) {
        await deps.updatesStore.setUpdate({ signal: "files", uri, stamp: transactionId });
        lastSeen.set(uri, file.updatedAt);
      }
    }
    return true;
  };
}

function newExtractor(deps: {
  files: FilesStore;
  content: ContentStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async () => {
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "Extractor")) {
      const file = deps.files.get(entry.uri);
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri: entry.uri,
        cell: "Extractor",
        stamp: entry.stamp,
      });
      if (file === undefined) continue;
      deps.content.set(entry.uri, file.body.toUpperCase());
      await deps.updatesStore.setUpdate({ signal: "content", uri: entry.uri, stamp: entry.stamp });
    }
    return true;
  };
}

function newChunker(deps: {
  content: ContentStore;
  chunks: ChunksStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async () => {
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "Chunker")) {
      const fileUri = entry.uri;
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri: fileUri,
        cell: "Chunker",
        stamp: entry.stamp,
      });
      const content = deps.content.get(fileUri);
      if (content === undefined) continue;
      const half = Math.ceil(content.length / 2);
      const parts: ReadonlyArray<string> = [content.slice(0, half), content.slice(half)];
      let i = 0;
      for (const part of parts) {
        const chunkUri = `${fileUri}#${i}`;
        deps.chunks.set(chunkUri, part);
        await deps.updatesStore.setUpdate({ signal: "chunks", uri: chunkUri, stamp: entry.stamp });
        i++;
      }
    }
    return true;
  };
}

function newEmbedder(deps: {
  chunks: ChunksStore;
  embeddings: EmbeddingsStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async () => {
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "Embedder")) {
      const chunkUri = entry.uri;
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri: chunkUri,
        cell: "Embedder",
        stamp: entry.stamp,
      });
      const chunk = deps.chunks.get(chunkUri);
      if (chunk === undefined) continue;
      deps.embeddings.set(chunkUri, [chunk.length, chunk.charCodeAt(0) ?? 0]);
      await deps.updatesStore.setUpdate({
        signal: "embeddings",
        uri: chunkUri,
        stamp: entry.stamp,
      });
    }
    return true;
  };
}

// Sink cell — consumes three input signals, produces nothing. Tracks
// consumption purely via `handleUpdate` (the old "first output watermark"
// requirement is gone). Indexes whenever an embedding update flows.
function newIndexer(deps: {
  chunks: ChunksStore;
  embeddings: EmbeddingsStore;
  index: IndexStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async () => {
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "Indexer")) {
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri: entry.uri,
        cell: "Indexer",
        stamp: entry.stamp,
      });
      if (entry.signal !== "embeddings") continue;
      const chunkUri = entry.uri;
      const embedding = deps.embeddings.get(chunkUri);
      const chunk = deps.chunks.get(chunkUri);
      if (embedding === undefined || chunk === undefined) continue;
      deps.index.set(chunkUri, { embedding, content: chunk });
    }
    return true;
  };
}

// Deletion cells — consume a `:removed` signal, mutate their domain, emit the
// next tombstone, and `removeUpdate` the upstream creation pair (which cascades
// away every cell's handled row for that URI).
function newContentRemover(deps: {
  content: ContentStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async () => {
    const removed: string[] = [];
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "ContentRemover")) {
      const uri = entry.uri;
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri,
        cell: "ContentRemover",
        stamp: entry.stamp,
      });
      deps.content.delete(uri);
      removed.push(uri);
      await deps.updatesStore.setUpdate({
        signal: "content:removed",
        uri,
        stamp: entry.stamp,
      });
    }
    await deps.updatesStore.removeUpdates(
      removed.flatMap((uri) => [
        { signal: "files", uri },
        { signal: "files:removed", uri },
      ]),
    );
    return true;
  };
}

function newChunksRemover(deps: { chunks: ChunksStore; updatesStore: UpdatesStore }): CellHandler {
  return async () => {
    const consumedFileUris: string[] = [];
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "ChunksRemover")) {
      const fileUri = entry.uri;
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri: fileUri,
        cell: "ChunksRemover",
        stamp: entry.stamp,
      });
      consumedFileUris.push(fileUri);
      const chunkPrefix = `${fileUri}#`;
      const removedChunkUris = [...deps.chunks.keys()].filter((c) => c.startsWith(chunkPrefix));
      for (const chunkUri of removedChunkUris) {
        deps.chunks.delete(chunkUri);
        await deps.updatesStore.setUpdate({
          signal: "chunks:removed",
          uri: chunkUri,
          stamp: entry.stamp,
        });
      }
    }
    await deps.updatesStore.removeUpdates(
      consumedFileUris.flatMap((uri) => [
        { signal: "content", uri },
        { signal: "content:removed", uri },
      ]),
    );
    return true;
  };
}

function newEmbeddingsRemover(deps: {
  embeddings: EmbeddingsStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async () => {
    const consumedChunkUris: string[] = [];
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "EmbeddingsRemover")) {
      const chunkUri = entry.uri;
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri: chunkUri,
        cell: "EmbeddingsRemover",
        stamp: entry.stamp,
      });
      deps.embeddings.delete(chunkUri);
      consumedChunkUris.push(chunkUri);
      await deps.updatesStore.setUpdate({
        signal: "embeddings:removed",
        uri: chunkUri,
        stamp: entry.stamp,
      });
    }
    await deps.updatesStore.removeUpdates(
      consumedChunkUris.flatMap((uri) => [
        { signal: "chunks", uri },
        { signal: "chunks:removed", uri },
      ]),
    );
    return true;
  };
}

function newIndexRemover(deps: { index: IndexStore; updatesStore: UpdatesStore }): CellHandler {
  return async () => {
    const consumedChunkUris: string[] = [];
    for await (const entry of readCellUpdates(deps.updatesStore, graph, "IndexRemover")) {
      const chunkUri = entry.uri;
      await deps.updatesStore.handleUpdate({
        signal: entry.signal,
        uri: chunkUri,
        cell: "IndexRemover",
        stamp: entry.stamp,
      });
      deps.index.delete(chunkUri);
      consumedChunkUris.push(chunkUri);
    }
    await deps.updatesStore.removeUpdates(
      consumedChunkUris.flatMap((uri) => [
        { signal: "embeddings", uri },
        { signal: "embeddings:removed", uri },
      ]),
    );
    return true;
  };
}

// -----------------------------------------------------------------------------

function buildPipeline() {
  const files: FilesStore = new Map();
  const content: ContentStore = new Map();
  const chunks: ChunksStore = new Map();
  const embeddings: EmbeddingsStore = new Map();
  const index: IndexStore = new Map();
  const updatesStore = new InMemoryUpdatesStore();
  const txStore = new InMemoryTransactionStore();

  const handlers: Record<string, CellHandler> = {
    FilesScanner: newFilesScanner({ files, updatesStore }),
    Extractor: newExtractor({ files, content, updatesStore }),
    Chunker: newChunker({ content, chunks, updatesStore }),
    Embedder: newEmbedder({ chunks, embeddings, updatesStore }),
    Indexer: newIndexer({ chunks, embeddings, index, updatesStore }),
    ContentRemover: newContentRemover({ content, updatesStore }),
    ChunksRemover: newChunksRemover({ chunks, updatesStore }),
    EmbeddingsRemover: newEmbeddingsRemover({ embeddings, updatesStore }),
    IndexRemover: newIndexRemover({ index, updatesStore }),
  };

  const manager = new UpdatesManager({ graph, store: txStore, handlers });

  return { files, content, chunks, embeddings, index, updatesStore, txStore, manager };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// -----------------------------------------------------------------------------

describe("UpdatesStore integration — pipeline anchor test (per-cell handled)", () => {
  it("scan-driven update cascade: scan → files → content → chunks → embeddings → index", async () => {
    const p = buildPipeline();

    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    p.files.set("f2", { body: "another file", updatedAt: 1 });

    await p.manager.exec({ signals: ["scan"] });

    expect(p.content.get("f1")).toBe("HELLO WORLD");
    expect(p.content.get("f2")).toBe("ANOTHER FILE");
    expect(new Set(p.chunks.keys())).toEqual(new Set(["f1#0", "f1#1", "f2#0", "f2#1"]));
    expect(p.embeddings.has("f1#0")).toBe(true);
    expect(p.embeddings.has("f2#1")).toBe(true);
    expect(new Set(p.index.keys())).toEqual(new Set(["f1#0", "f1#1", "f2#0", "f2#1"]));

    const filesRows = await collect(p.updatesStore.readEntries({ signal: "files", since: 0 }));
    expect(filesRows.map((e) => e.uri).sort()).toEqual(["f1", "f2"]);
    const contentRows = await collect(p.updatesStore.readEntries({ signal: "content", since: 0 }));
    expect(contentRows.map((e) => e.uri).sort()).toEqual(["f1", "f2"]);
    const chunksRows = await collect(p.updatesStore.readEntries({ signal: "chunks", since: 0 }));
    expect(chunksRows.map((e) => e.uri).sort()).toEqual(["f1#0", "f1#1", "f2#0", "f2#1"]);
    const embRows = await collect(p.updatesStore.readEntries({ signal: "embeddings", since: 0 }));
    expect(embRows.map((e) => e.uri).sort()).toEqual(["f1#0", "f1#1", "f2#0", "f2#1"]);

    // The sink Indexer recorded consumption via handleUpdate (no output signal).
    expect(
      await collect(p.updatesStore.readUpdates({ signal: "embeddings", cell: "Indexer" })),
    ).toEqual([]);

    for (const cellId of ["FilesScanner", "Extractor", "Chunker", "Embedder", "Indexer"]) {
      expect(await p.txStore.getCellTransaction(cellId)).toBeGreaterThan(0);
    }
  });

  it("re-indexing: changing a file's content + timestamp re-runs the full cascade", async () => {
    const p = buildPipeline();

    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    await p.manager.exec({ signals: ["scan"] });
    expect(p.content.get("f1")).toBe("HELLO WORLD");
    expect(p.chunks.get("f1#0")).toBe("HELLO ");
    const txAfterFirstRun = await p.txStore.getCellTransaction("Indexer");
    expect(txAfterFirstRun).toBeGreaterThan(0);

    p.files.set("f1", { body: "good night", updatedAt: 2 });
    await p.manager.exec({ signals: ["scan"] });

    expect(p.content.get("f1")).toBe("GOOD NIGHT");
    expect(p.chunks.get("f1#0")).toBe("GOOD ");
    expect(p.chunks.get("f1#1")).toBe("NIGHT");
    expect(p.index.get("f1#0")?.content).toBe("GOOD ");
    expect(p.index.get("f1#1")?.content).toBe("NIGHT");

    for (const cellId of ["FilesScanner", "Extractor", "Chunker", "Embedder", "Indexer"]) {
      expect(await p.txStore.getCellTransaction(cellId)).toBeGreaterThan(txAfterFirstRun);
    }
  });

  it("deletion cascade removes domain rows and cleans up updates AND handled rows", async () => {
    const p = buildPipeline();

    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    p.files.set("f2", { body: "another file", updatedAt: 1 });
    await p.manager.exec({ signals: ["scan"] });

    p.files.delete("f1");
    const removalTx = await p.txStore.newTransactionId();
    await p.updatesStore.setUpdate({ signal: "files:removed", uri: "f1", stamp: removalTx });

    await p.manager.exec({ signals: ["files:removed"] });

    expect(p.content.has("f1")).toBe(false);
    expect(p.chunks.has("f1#0")).toBe(false);
    expect(p.embeddings.has("f1#1")).toBe(false);
    expect(p.index.has("f1#0")).toBe(false);

    expect(p.content.get("f2")).toBe("ANOTHER FILE");
    expect(p.index.has("f2#0")).toBe(true);

    // No f1-related rows in EITHER relation of the snapshot.
    const snap = p.updatesStore.snapshot();
    const f1Updates: string[] = [];
    for (const [signal, rows] of Object.entries(snap.updates)) {
      for (const uri of Object.keys(rows)) {
        if (uri === "f1" || uri.startsWith("f1#")) f1Updates.push(`${signal}:${uri}`);
      }
    }
    const f1Handled: string[] = [];
    for (const [signal, cells] of Object.entries(snap.handled)) {
      for (const [cell, rows] of Object.entries(cells)) {
        for (const uri of Object.keys(rows)) {
          if (uri === "f1" || uri.startsWith("f1#")) f1Handled.push(`${signal}/${cell}:${uri}`);
        }
      }
    }
    expect(f1Updates).toEqual([]);
    expect(f1Handled).toEqual([]);

    // f2's creation rows survive.
    expect(snap.updates.files?.f2).toBeDefined();
    expect(snap.updates.content?.f2).toBeDefined();
    expect(snap.updates.chunks?.["f2#0"]).toBeDefined();
    expect(snap.updates.embeddings?.["f2#1"]).toBeDefined();
  });

  it("idempotent re-scan: with no file changes every handler reads nothing and mutates nothing", async () => {
    const p = buildPipeline();

    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    await p.manager.exec({ signals: ["scan"] });

    const contentBefore = new Map(p.content);
    const chunksBefore = new Map(p.chunks);
    const embeddingsBefore = new Map(p.embeddings);
    const indexBefore = new Map(p.index);
    const updatesBefore = p.updatesStore.snapshot();

    await p.manager.exec({ signals: ["scan"] });

    expect(p.content).toEqual(contentBefore);
    expect(p.chunks).toEqual(chunksBefore);
    expect(p.embeddings).toEqual(embeddingsBefore);
    expect(p.index).toEqual(indexBefore);
    expect(p.updatesStore.snapshot()).toEqual(updatesBefore);

    // Every cell is caught up: readUpdates yields nothing.
    expect(
      await collect(p.updatesStore.readUpdates({ signal: "files", cell: "Extractor" })),
    ).toEqual([]);
    expect(
      await collect(p.updatesStore.readUpdates({ signal: "embeddings", cell: "Indexer" })),
    ).toEqual([]);
  });
});
