import { describe, expect, it } from "vitest";
import { DataflowGraph } from "../src/dataflow-graph.js";
import { InMemoryTransactionStore } from "../src/in-memory-transaction-store.js";
import { UpdatesManager } from "../src/updates-manager.js";

describe("UpdatesManager — tracer", () => {
  it("invokes a cell's handler with updateId=0 and the new transactionId, recording the tx on success", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["S"], outputs: [] }]);
    const store = new InMemoryTransactionStore();
    const seen: Array<{ updateId: number; transactionId: number }> = [];

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async (params) => {
          seen.push(params);
          return true;
        },
      },
    });

    await manager.run(["S"]);

    expect(seen).toEqual([{ updateId: 0, transactionId: 1 }]);
    expect(await store.getCellTransaction("A")).toBe(1);
  });
});

describe("UpdatesManager — topological execution", () => {
  it("runs A→B→C in topological order when seeds reach A", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: ["y"] },
      { id: "C", inputs: ["y"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const order: string[] = [];

    const make = (id: string) => async () => {
      order.push(id);
      return true;
    };
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: { A: make("A"), B: make("B"), C: make("C") },
    });

    await manager.run(["S"]);

    expect(order).toEqual(["A", "B", "C"]);
    expect(await store.getCellTransaction("A")).toBe(1);
    expect(await store.getCellTransaction("B")).toBe(1);
    expect(await store.getCellTransaction("C")).toBe(1);
  });

  it("catches handler exceptions, treats them as false, and forwards to onError", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const errors: Array<{ cellId: string; error: unknown }> = [];
    let bRan = false;
    const boom = new Error("boom");

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          throw boom;
        },
        B: async () => {
          bRan = true;
          return true;
        },
      },
      onError: (cellId, error) => errors.push({ cellId, error }),
    });

    await expect(manager.run(["S"])).resolves.toBeUndefined(); // does not propagate
    expect(await store.getCellTransaction("A")).toBe(0); // not recorded
    expect(errors).toEqual([{ cellId: "A", error: boom }]); // onError called once with the throw
    expect(bRan).toBe(true); // downstream still runs
  });

  it("does not record tx for a cell whose handler returned false; downstream cells still run", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    let bRan = false;

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => false, // fails
        B: async () => {
          bRan = true;
          return true;
        },
      },
    });

    await manager.run(["S"]);

    expect(await store.getCellTransaction("A")).toBe(0); // not recorded
    expect(bRan).toBe(true); // downstream still runs
    expect(await store.getCellTransaction("B")).toBe(1); // B succeeded
  });

  it("passes the prior successful tx as updateId on subsequent activations", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["S"], outputs: [] }]);
    const store = new InMemoryTransactionStore();
    const seenUpdateIds: number[] = [];

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async ({ updateId }) => {
          seenUpdateIds.push(updateId);
          return true;
        },
      },
    });

    await manager.run(["S"]); // tx=1
    await manager.run(["S"]); // tx=2
    await manager.run(["S"]); // tx=3

    expect(seenUpdateIds).toEqual([0, 1, 2]);
    expect(await store.getCellTransaction("A")).toBe(3);
  });

  it("invokes a cell exactly once even when multiple seeds reach it", async () => {
    // A reads S1 and S2; if both are in seeds, A must still run only once.
    const graph = new DataflowGraph([
      { id: "A", inputs: ["S1", "S2"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    let aCalls = 0;
    let bCalls = 0;

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          aCalls++;
          return true;
        },
        B: async () => {
          bCalls++;
          return true;
        },
      },
    });

    await manager.run(["S1", "S2"]);

    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  it("rejects a second run() while one is already in flight", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["S"], outputs: [] }]);
    const store = new InMemoryTransactionStore();
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          await gate; // hold the activation open
          return true;
        },
      },
    });

    const first = manager.run(["S"]);
    await expect(manager.run(["S"])).rejects.toThrow(
      /already in progress|already running|in flight/i,
    );
    release();
    await first; // first run still completes cleanly
    expect(await store.getCellTransaction("A")).toBe(1);
  });

  it("can be re-invoked after the previous activation has finished", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["S"], outputs: [] }]);
    const store = new InMemoryTransactionStore();
    let calls = 0;

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          calls++;
          return true;
        },
      },
    });

    await manager.run(["S"]);
    await manager.run(["S"]);
    expect(calls).toBe(2);
  });

  it("silently skips cells that have no registered handler; downstream cells still run", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: ["y"] }, // no handler registered
      { id: "C", inputs: ["y"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const order: string[] = [];

    const make = (id: string) => async () => {
      order.push(id);
      return true;
    };
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: { A: make("A"), C: make("C") }, // B intentionally absent
    });

    await manager.run(["S"]);

    expect(order).toEqual(["A", "C"]);
    expect(await store.getCellTransaction("A")).toBe(1);
    expect(await store.getCellTransaction("B")).toBe(0); // never recorded
    expect(await store.getCellTransaction("C")).toBe(1);
  });

  it("does nothing when called with no seeds and the graph has no probers", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: [] }, // no probers
    ]);
    const store = new InMemoryTransactionStore();
    let called = false;

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          called = true;
          return true;
        },
      },
    });

    await manager.run();

    expect(called).toBe(false);
    expect(await store.getCellTransaction("A")).toBe(0);
    // tx counter still advances on activation start
    expect(await store.newTransactionId()).toBe(2);
  });

  it("runs all probers (cells with no inputs) and their cascade when called with no seeds", async () => {
    const graph = new DataflowGraph([
      { id: "P1", inputs: [], outputs: ["x"] }, // prober
      { id: "P2", inputs: [], outputs: ["y"] }, // prober
      { id: "C", inputs: ["x", "y"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const order: string[] = [];

    const make = (id: string) => async () => {
      order.push(id);
      return true;
    };
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: { P1: make("P1"), P2: make("P2"), C: make("C") },
    });

    await manager.run();

    expect(new Set(order)).toEqual(new Set(["P1", "P2", "C"]));
    // C must come after both probers
    const idx = (id: string) => order.indexOf(id);
    expect(idx("C")).toBeGreaterThan(idx("P1"));
    expect(idx("C")).toBeGreaterThan(idx("P2"));
    expect(await store.getCellTransaction("P1")).toBe(1);
    expect(await store.getCellTransaction("P2")).toBe(1);
    expect(await store.getCellTransaction("C")).toBe(1);
  });

  it("keeps updateId = last *successful* tx across a failed activation", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["S"], outputs: [] }]);
    const store = new InMemoryTransactionStore();
    const seenUpdateIds: number[] = [];
    let attempt = 0;

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async ({ updateId }) => {
          seenUpdateIds.push(updateId);
          attempt += 1;
          // Succeed on attempt 1, fail on 2, succeed on 3.
          return attempt !== 2;
        },
      },
    });

    await manager.run(["S"]); // tx=1, success → record 1
    await manager.run(["S"]); // tx=2, FAIL → record stays at 1
    await manager.run(["S"]); // tx=3, success → record 3

    expect(seenUpdateIds).toEqual([0, 1, 1]); // updateId stays at 1 after failed run
    expect(await store.getCellTransaction("A")).toBe(3);
  });

  it("allocates one transactionId per activation; all cells share it", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const seenTx: Record<string, number[]> = { A: [], B: [] };

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async ({ transactionId }) => {
          seenTx.A?.push(transactionId);
          return true;
        },
        B: async ({ transactionId }) => {
          seenTx.B?.push(transactionId);
          return true;
        },
      },
    });

    await manager.run(["S"]);

    expect(seenTx.A).toHaveLength(1);
    expect(seenTx.B).toHaveLength(1);
    expect(seenTx.A?.[0]).toBe(seenTx.B?.[0]);
  });
});
