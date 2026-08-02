import { joinPath, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { BuildEngine, NULL_LOGGER, SOURCES_SIGNAL } from "./index.js";
import { tryReadJson } from "./json-io.js";

/** A host that carries a back-reference to its engine, so a builder can drain
 *  its own input via `host.engine.readUpdates(...)` — the Project-free analogue of
 *  `project.requireAdapter(ProjectBuilder)`. */
interface Host {
  engine: BuildEngine<Host>;
}

describe("BuildEngine — BuildContext constructor", () => {
  it("runs a trivial 1-cell graph over a MemFilesApi and persists transactions.json", async () => {
    const files = new MemFilesApi();
    const rootPath = "proj";
    await writeText(files, joinPath(rootPath, "note.txt"), "hello");

    const host = {} as Host;
    const engine = new BuildEngine<Host>({
      files,
      rootPath,
      systemFolder: ".project",
      logger: NULL_LOGGER,
      host,
    });
    host.engine = engine;

    // One builder: reads `sources`, drains each, and emits an `indexed` update.
    // Proves the engine hands the injected host through to `handler(host)`.
    let sawHost: unknown;
    engine.registerBuilder({
      id: "Indexer",
      inputs: [SOURCES_SIGNAL],
      outputs: ["indexed"],
      handler: async function* (h) {
        sawHost = h;
        for await (const u of h.engine.readUpdates({ signal: SOURCES_SIGNAL, cell: "Indexer" })) {
          yield { signal: "indexed", uri: u.uri, stamp: u.stamp };
          await u.handled();
        }
        return true;
      },
    });

    for await (const _ of engine.run()) {
      // drain progress events to convergence
    }

    expect(sawHost).toBe(host);

    const snap = await tryReadJson<{
      nextTransactionId: number;
      cellTransactions: Record<string, number>;
    }>(files, joinPath(rootPath, ".project/state/transactions.json"));
    expect(snap).toBeDefined();
    // The scanner surfaced `note.txt` and the Indexer drained it — both reached
    // the frontier transaction, recorded in the persisted store.
    expect(snap?.cellTransactions.Indexer).toBeGreaterThan(0);
  });
});
