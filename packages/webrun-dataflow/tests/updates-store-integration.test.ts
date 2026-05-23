import { describe, expect, it } from "vitest";
import { DataflowGraph } from "../src/dataflow-graph.js";
import { InMemoryTransactionStore } from "../src/in-memory-transaction-store.js";
import { InMemoryUpdatesStore } from "../src/in-memory-updates-store.js";
import type { CellHandler } from "../src/updates-manager.js";
import { UpdatesManager } from "../src/updates-manager.js";
import type { UpdatesStore } from "../src/updates-store.js";

// -----------------------------------------------------------------------------
// Test domain stores — what handlers actually mutate. The UpdatesStore only
// carries pointers; the data lives here.

/** A file body carries its own update timestamp — what the scanner watches. */
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
// Handler factories. Each returns a plain CellHandler that closes over its
// dependencies. Per D6, no UpdatesHandler type — just CellHandler + closures.

function newExtractor(deps: {
  files: FilesStore;
  content: ContentStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async ({ updateId, transactionId }) => {
    for await (const { uri } of deps.updatesStore.readEntries({
      signal: "files",
      since: updateId,
    })) {
      const file = deps.files.get(uri);
      if (file === undefined) continue;
      deps.content.set(uri, file.body.toUpperCase());
      await deps.updatesStore.saveEntry({
        signal: "content",
        uri,
        stamp: transactionId,
      });
    }
    return true;
  };
}

function newChunker(deps: {
  content: ContentStore;
  chunks: ChunksStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async ({ updateId, transactionId }) => {
    for await (const { uri: fileUri } of deps.updatesStore.readEntries({
      signal: "content",
      since: updateId,
    })) {
      const content = deps.content.get(fileUri);
      if (content === undefined) continue;
      // Two chunks per file, deterministic split.
      const half = Math.ceil(content.length / 2);
      const parts: ReadonlyArray<string> = [content.slice(0, half), content.slice(half)];
      let i = 0;
      for (const part of parts) {
        const chunkUri = `${fileUri}#${i}`;
        deps.chunks.set(chunkUri, part);
        await deps.updatesStore.saveEntry({
          signal: "chunks",
          uri: chunkUri,
          stamp: transactionId,
        });
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
  return async ({ updateId, transactionId }) => {
    for await (const { uri: chunkUri } of deps.updatesStore.readEntries({
      signal: "chunks",
      since: updateId,
    })) {
      const chunk = deps.chunks.get(chunkUri);
      if (chunk === undefined) continue;
      deps.embeddings.set(chunkUri, [chunk.length, chunk.charCodeAt(0) ?? 0]);
      await deps.updatesStore.saveEntry({
        signal: "embeddings",
        uri: chunkUri,
        stamp: transactionId,
      });
    }
    return true;
  };
}

function newIndexer(deps: {
  content: ContentStore;
  chunks: ChunksStore;
  embeddings: EmbeddingsStore;
  index: IndexStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async ({ updateId }) => {
    // Re-index every chunk whose embedding has changed since last run.
    for await (const { uri: chunkUri } of deps.updatesStore.readEntries({
      signal: "embeddings",
      since: updateId,
    })) {
      const embedding = deps.embeddings.get(chunkUri);
      const chunk = deps.chunks.get(chunkUri);
      if (embedding === undefined || chunk === undefined) continue;
      deps.index.set(chunkUri, { embedding, content: chunk });
    }
    return true;
  };
}

// Scanner — the cell at the top of the pipeline. Consumes the `scan` trigger
// signal, observes the files domain (which carries per-file `updatedAt`
// timestamps), and emits `{ signal: "files", uri, stamp: transactionId }`
// for every file whose `updatedAt` is greater than the last value the scanner
// observed for that URI. State is held in closure — the scanner's own private
// bookkeeping, not part of `UpdatesStore`.

function newFilesScanner(deps: { files: FilesStore; updatesStore: UpdatesStore }): CellHandler {
  const lastSeen = new Map<string, number>();
  return async ({ transactionId }) => {
    for (const [uri, file] of deps.files) {
      const seen = lastSeen.get(uri) ?? 0;
      if (file.updatedAt > seen) {
        await deps.updatesStore.saveEntry({
          signal: "files",
          uri,
          stamp: transactionId,
        });
        lastSeen.set(uri, file.updatedAt);
      }
    }
    return true;
  };
}

// Deletion cells. Per the D12 convention: each tombstone-consuming handler
// (a) mutates its own domain, (b) emits the next tombstone signal, (c) removes
// the upstream pair (creation-signal row + consumed `:removed` row) for every
// URI it just processed.

function newContentRemover(deps: {
  content: ContentStore;
  updatesStore: UpdatesStore;
}): CellHandler {
  return async ({ updateId, transactionId }) => {
    const removed: string[] = [];
    for await (const { uri } of deps.updatesStore.readEntries({
      signal: "files:removed",
      since: updateId,
    })) {
      deps.content.delete(uri);
      removed.push(uri);
      await deps.updatesStore.saveEntry({
        signal: "content:removed",
        uri,
        stamp: transactionId,
      });
    }
    await deps.updatesStore.removeEntries(
      removed.flatMap((uri) => [
        { signal: "files", uri },
        { signal: "files:removed", uri },
      ]),
    );
    return true;
  };
}

function newChunksRemover(deps: { chunks: ChunksStore; updatesStore: UpdatesStore }): CellHandler {
  return async ({ updateId, transactionId }) => {
    const consumedFileUris: string[] = [];
    for await (const { uri: fileUri } of deps.updatesStore.readEntries({
      signal: "content:removed",
      since: updateId,
    })) {
      consumedFileUris.push(fileUri);
      // Find chunk URIs belonging to this file by `${fileUri}#` prefix.
      const chunkPrefix = `${fileUri}#`;
      const removedChunkUris: string[] = [];
      for (const chunkUri of deps.chunks.keys()) {
        if (chunkUri.startsWith(chunkPrefix)) removedChunkUris.push(chunkUri);
      }
      for (const chunkUri of removedChunkUris) {
        deps.chunks.delete(chunkUri);
        await deps.updatesStore.saveEntry({
          signal: "chunks:removed",
          uri: chunkUri,
          stamp: transactionId,
        });
      }
    }
    await deps.updatesStore.removeEntries(
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
  return async ({ updateId, transactionId }) => {
    const consumedChunkUris: string[] = [];
    for await (const { uri: chunkUri } of deps.updatesStore.readEntries({
      signal: "chunks:removed",
      since: updateId,
    })) {
      deps.embeddings.delete(chunkUri);
      consumedChunkUris.push(chunkUri);
      await deps.updatesStore.saveEntry({
        signal: "embeddings:removed",
        uri: chunkUri,
        stamp: transactionId,
      });
    }
    await deps.updatesStore.removeEntries(
      consumedChunkUris.flatMap((uri) => [
        { signal: "chunks", uri },
        { signal: "chunks:removed", uri },
      ]),
    );
    return true;
  };
}

function newIndexRemover(deps: { index: IndexStore; updatesStore: UpdatesStore }): CellHandler {
  return async ({ updateId }) => {
    const consumedChunkUris: string[] = [];
    for await (const { uri: chunkUri } of deps.updatesStore.readEntries({
      signal: "embeddings:removed",
      since: updateId,
    })) {
      deps.index.delete(chunkUri);
      consumedChunkUris.push(chunkUri);
    }
    await deps.updatesStore.removeEntries(
      consumedChunkUris.flatMap((uri) => [
        { signal: "embeddings", uri },
        { signal: "embeddings:removed", uri },
      ]),
    );
    return true;
  };
}

// -----------------------------------------------------------------------------
// Pipeline fixture — graph + stores + handlers + manager all wired up.

function buildPipeline() {
  const files: FilesStore = new Map();
  const content: ContentStore = new Map();
  const chunks: ChunksStore = new Map();
  const embeddings: EmbeddingsStore = new Map();
  const index: IndexStore = new Map();
  const updatesStore = new InMemoryUpdatesStore();
  const txStore = new InMemoryTransactionStore();

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

  const handlers: Record<string, CellHandler> = {
    FilesScanner: newFilesScanner({ files, updatesStore }),
    Extractor: newExtractor({ files, content, updatesStore }),
    Chunker: newChunker({ content, chunks, updatesStore }),
    Embedder: newEmbedder({ chunks, embeddings, updatesStore }),
    Indexer: newIndexer({ content, chunks, embeddings, index, updatesStore }),
    ContentRemover: newContentRemover({ content, updatesStore }),
    ChunksRemover: newChunksRemover({ chunks, updatesStore }),
    EmbeddingsRemover: newEmbeddingsRemover({ embeddings, updatesStore }),
    IndexRemover: newIndexRemover({ index, updatesStore }),
  };

  const manager = new UpdatesManager({ graph, store: txStore, handlers });

  return {
    files,
    content,
    chunks,
    embeddings,
    index,
    updatesStore,
    txStore,
    manager,
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// -----------------------------------------------------------------------------

describe("UpdatesStore integration — pipeline anchor test", () => {
  it("scan-driven update cascade: scan → files → content → chunks → embeddings → index", async () => {
    const p = buildPipeline();

    // Two files exist on disk with the same update timestamp.
    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    p.files.set("f2", { body: "another file", updatedAt: 1 });

    // Trigger the scanner. Scanner emits `files` entries for the changed
    // files; the cascade flows downstream from there.
    await p.manager.exec({ signals: ["scan"] });

    // Every downstream domain store holds the derived data.
    expect(p.content.get("f1")).toBe("HELLO WORLD");
    expect(p.content.get("f2")).toBe("ANOTHER FILE");

    expect(new Set(p.chunks.keys())).toEqual(new Set(["f1#0", "f1#1", "f2#0", "f2#1"]));

    expect(p.embeddings.has("f1#0")).toBe(true);
    expect(p.embeddings.has("f1#1")).toBe(true);
    expect(p.embeddings.has("f2#0")).toBe(true);
    expect(p.embeddings.has("f2#1")).toBe(true);

    expect(new Set(p.index.keys())).toEqual(new Set(["f1#0", "f1#1", "f2#0", "f2#1"]));

    // UpdatesStore holds matching pointer entries on every signal in the
    // cascade — the scanner published `files`, the downstream cells published
    // the rest.
    const filesRows = await collect(p.updatesStore.readEntries({ signal: "files", since: 0 }));
    expect(filesRows.map((e) => e.uri).sort()).toEqual(["f1", "f2"]);

    const contentRows = await collect(p.updatesStore.readEntries({ signal: "content", since: 0 }));
    expect(contentRows.map((e) => e.uri).sort()).toEqual(["f1", "f2"]);

    const chunksRows = await collect(p.updatesStore.readEntries({ signal: "chunks", since: 0 }));
    expect(chunksRows.map((e) => e.uri).sort()).toEqual(["f1#0", "f1#1", "f2#0", "f2#1"]);

    const embeddingsRows = await collect(
      p.updatesStore.readEntries({ signal: "embeddings", since: 0 }),
    );
    expect(embeddingsRows.map((e) => e.uri).sort()).toEqual(["f1#0", "f1#1", "f2#0", "f2#1"]);

    // Every cell's TransactionStore entry advanced.
    for (const cellId of ["FilesScanner", "Extractor", "Chunker", "Embedder", "Indexer"]) {
      expect(await p.txStore.getCellTransaction(cellId)).toBeGreaterThan(0);
    }
  });

  it("re-indexing: changing a file's content + timestamp re-runs the full cascade with the new body", async () => {
    const p = buildPipeline();

    // First scan — establishes the initial state.
    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    await p.manager.exec({ signals: ["scan"] });
    expect(p.content.get("f1")).toBe("HELLO WORLD");
    expect(p.chunks.get("f1#0")).toBe("HELLO ");
    expect(p.chunks.get("f1#1")).toBe("WORLD");
    const indexedV1 = p.index.get("f1#0");
    expect(indexedV1?.content).toBe("HELLO ");
    const txAfterFirstRun = await p.txStore.getCellTransaction("Indexer");
    expect(txAfterFirstRun).toBeGreaterThan(0);

    // The file changes on disk: new body, bumped `updatedAt`.
    p.files.set("f1", { body: "good night", updatedAt: 2 });

    // Re-trigger the scanner. The scanner notices `updatedAt` advanced and
    // re-emits a `files` entry; every downstream cell sees the new stamp
    // above its last `updateId` and re-processes the URI.
    await p.manager.exec({ signals: ["scan"] });

    // The full cascade has refreshed every domain row that depends on f1.
    expect(p.content.get("f1")).toBe("GOOD NIGHT");
    expect(p.chunks.get("f1#0")).toBe("GOOD ");
    expect(p.chunks.get("f1#1")).toBe("NIGHT");
    expect(p.index.get("f1#0")?.content).toBe("GOOD ");
    expect(p.index.get("f1#1")?.content).toBe("NIGHT");

    // Every cell's recorded tx has advanced past the first run.
    for (const cellId of ["FilesScanner", "Extractor", "Chunker", "Embedder", "Indexer"]) {
      expect(await p.txStore.getCellTransaction(cellId)).toBeGreaterThan(txAfterFirstRun);
    }
  });

  it("deletion cascade removes domain rows and cleans up every paired UpdatesStore entry", async () => {
    const p = buildPipeline();

    // Establish post-update state via the scanner.
    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    p.files.set("f2", { body: "another file", updatedAt: 1 });
    await p.manager.exec({ signals: ["scan"] });

    // The file disappeared from disk. The test seeds the tombstone directly
    // because the scanner here only emits "files"; a real implementation
    // would couple the scanner to a deletion-detection path.
    p.files.delete("f1");
    const removalTx = await p.txStore.newTransactionId();
    await p.updatesStore.saveEntry({
      signal: "files:removed",
      uri: "f1",
      stamp: removalTx,
    });

    await p.manager.exec({ signals: ["files:removed"] });

    // Domain stores no longer hold any f1-derived data.
    expect(p.content.has("f1")).toBe(false);
    expect(p.chunks.has("f1#0")).toBe(false);
    expect(p.chunks.has("f1#1")).toBe(false);
    expect(p.embeddings.has("f1#0")).toBe(false);
    expect(p.embeddings.has("f1#1")).toBe(false);
    expect(p.index.has("f1#0")).toBe(false);
    expect(p.index.has("f1#1")).toBe(false);

    // f2 is untouched.
    expect(p.content.get("f2")).toBe("ANOTHER FILE");
    expect(p.chunks.has("f2#0")).toBe(true);
    expect(p.embeddings.has("f2#1")).toBe(true);
    expect(p.index.has("f2#0")).toBe(true);

    // Every paired UpdatesStore entry for f1 (and its chunk URIs) is gone.
    const remaining = p.updatesStore.snapshot();
    const allRows: Array<[string, string]> = [];
    for (const [signal, signalRows] of Object.entries(remaining)) {
      for (const uri of Object.keys(signalRows)) {
        allRows.push([signal, uri]);
      }
    }
    const f1Related = allRows.filter(([, uri]) => uri === "f1" || uri.startsWith("f1#"));
    expect(f1Related).toEqual([]);

    // f2's rows are still present on the creation signals.
    expect(remaining.files?.f2).toBeDefined();
    expect(remaining.content?.f2).toBeDefined();
    expect(remaining.chunks?.["f2#0"]).toBeDefined();
    expect(remaining.chunks?.["f2#1"]).toBeDefined();
    expect(remaining.embeddings?.["f2#0"]).toBeDefined();
    expect(remaining.embeddings?.["f2#1"]).toBeDefined();
  });

  it("idempotent re-scan: with no file changes every handler reads nothing and mutates nothing", async () => {
    const p = buildPipeline();

    p.files.set("f1", { body: "hello world", updatedAt: 1 });
    await p.manager.exec({ signals: ["scan"] });

    // Snapshot domain state after first run.
    const contentBefore = new Map(p.content);
    const chunksBefore = new Map(p.chunks);
    const embeddingsBefore = new Map(p.embeddings);
    const indexBefore = new Map(p.index);
    const updatesBefore = p.updatesStore.snapshot();

    // Re-run the scanner with no file changes — `updatedAt` is unchanged.
    await p.manager.exec({ signals: ["scan"] });

    // Domain stores are unchanged.
    expect(p.content).toEqual(contentBefore);
    expect(p.chunks).toEqual(chunksBefore);
    expect(p.embeddings).toEqual(embeddingsBefore);
    expect(p.index).toEqual(indexBefore);

    // The UpdatesStore is unchanged — the scanner emitted nothing (file's
    // `updatedAt` did not move), so downstream cells had nothing to read and
    // emitted nothing in turn.
    expect(p.updatesStore.snapshot()).toEqual(updatesBefore);
  });
});
