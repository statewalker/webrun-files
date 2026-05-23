import { describe, expect, it } from "vitest";
import { DataflowGraph } from "../src/dataflow-graph.js";
import { InMemoryTransactionStore } from "../src/in-memory-transaction-store.js";
import { UpdatesManager } from "../src/updates-manager.js";

describe("UpdatesManager — tracer", () => {
  it("invokes a cell's handler with updateId=0 and the new transactionId, recording the tx on success", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["s"], outputs: [] }]);
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

    await manager.exec({ signals: ["s"] });

    expect(seen).toEqual([{ updateId: 0, transactionId: 1 }]);
    expect(await store.getCellTransaction("A")).toBe(1);
  });
});

describe("UpdatesManager — topological execution", () => {
  it("runs A→B→C in topological order when seeds reach A", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
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

    await manager.exec({ signals: ["s"] });

    expect(order).toEqual(["A", "B", "C"]);
    expect(await store.getCellTransaction("A")).toBe(1);
    expect(await store.getCellTransaction("B")).toBe(1);
    expect(await store.getCellTransaction("C")).toBe(1);
  });

  it("catches handler exceptions, treats them as false, and forwards to onError", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
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

    await expect(manager.exec({ signals: ["s"] })).resolves.toBeUndefined(); // does not propagate
    expect(await store.getCellTransaction("A")).toBe(0); // not recorded
    expect(errors).toEqual([{ cellId: "A", error: boom }]); // onError called once with the throw
    expect(bRan).toBe(true); // downstream still runs
  });

  it("does not record tx for a cell whose handler returned false; downstream cells still run", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
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

    await manager.exec({ signals: ["s"] });

    expect(await store.getCellTransaction("A")).toBe(0); // not recorded
    expect(bRan).toBe(true); // downstream still runs
    expect(await store.getCellTransaction("B")).toBe(1); // B succeeded
  });

  it("passes the prior successful tx as updateId on subsequent activations", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["s"], outputs: [] }]);
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

    await manager.exec({ signals: ["s"] }); // tx=1
    await manager.exec({ signals: ["s"] }); // tx=2
    await manager.exec({ signals: ["s"] }); // tx=3

    expect(seenUpdateIds).toEqual([0, 1, 2]);
    expect(await store.getCellTransaction("A")).toBe(3);
  });

  it("invokes a cell exactly once even when multiple seeds reach it", async () => {
    // A reads S1 and S2; if both are in seeds, A must still run only once.
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s1", "s2"], outputs: ["x"] },
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

    await manager.exec({ signals: ["s1", "s2"] });

    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  it("rejects a second run() while one is already in flight", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["s"], outputs: [] }]);
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

    const first = manager.exec({ signals: ["s"] });
    await expect(manager.exec({ signals: ["s"] })).rejects.toThrow(
      /already in progress|already running|in flight/i,
    );
    release();
    await first; // first run still completes cleanly
    expect(await store.getCellTransaction("A")).toBe(1);
  });

  it("can be re-invoked after the previous activation has finished", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["s"], outputs: [] }]);
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

    await manager.exec({ signals: ["s"] });
    await manager.exec({ signals: ["s"] });
    expect(calls).toBe(2);
  });

  it("silently skips cells that have no registered handler; downstream cells still run", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
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

    await manager.exec({ signals: ["s"] });

    expect(order).toEqual(["A", "C"]);
    expect(await store.getCellTransaction("A")).toBe(1);
    expect(await store.getCellTransaction("B")).toBe(0); // never recorded
    expect(await store.getCellTransaction("C")).toBe(1);
  });

  it("does nothing when called with no seeds and the graph has no probers", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: [] }, // no probers
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

    await manager.exec();

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

    await manager.exec();

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
    const graph = new DataflowGraph([{ id: "A", inputs: ["s"], outputs: [] }]);
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

    await manager.exec({ signals: ["s"] }); // tx=1, success → record 1
    await manager.exec({ signals: ["s"] }); // tx=2, FAIL → record stays at 1
    await manager.exec({ signals: ["s"] }); // tx=3, success → record 3

    expect(seenUpdateIds).toEqual([0, 1, 1]); // updateId stays at 1 after failed run
    expect(await store.getCellTransaction("A")).toBe(3);
  });

  it("does not mistake Object.prototype methods for handlers when cell ids collide with them", async () => {
    // Cell ids matching Object.prototype property names (`constructor`,
    // `toString`, ...) must NOT pick up the prototype method as a handler.
    // Without an own-property handler registered, the cell must be skipped.
    const graph = new DataflowGraph([
      { id: "constructor", inputs: ["s"], outputs: ["x"] },
      { id: "toString", inputs: ["x"], outputs: ["y"] },
      { id: "hasOwnProperty", inputs: ["y"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const errors: Array<{ cellId: string; error: unknown }> = [];

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {}, // no handlers at all — every cell must be silently skipped
      onError: (cellId, error) => errors.push({ cellId, error }),
    });

    await manager.exec({ signals: ["s"] });

    expect(await store.getCellTransaction("constructor")).toBe(0);
    expect(await store.getCellTransaction("toString")).toBe(0);
    expect(await store.getCellTransaction("hasOwnProperty")).toBe(0);
    expect(errors).toEqual([]);
  });

  it("survives a throwing onError callback and continues running remaining cells", async () => {
    // onError is documented as a passive notifier ("exception is otherwise
    // swallowed") — a buggy logger that itself throws must not abort the run
    // and strand mid-activation state.
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    let bRan = false;

    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          throw new Error("A failed");
        },
        B: async () => {
          bRan = true;
          return true;
        },
      },
      onError: () => {
        throw new Error("logger is broken");
      },
    });

    await expect(manager.exec({ signals: ["s"] })).resolves.toBeUndefined();
    expect(bRan).toBe(true);
    expect(await store.getCellTransaction("B")).toBe(1);
  });

  it("allocates one transactionId per activation; all cells share it", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
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

    await manager.exec({ signals: ["s"] });

    expect(seenTx.A).toHaveLength(1);
    expect(seenTx.B).toHaveLength(1);
    expect(seenTx.A?.[0]).toBe(seenTx.B?.[0]);
  });
});

describe("UpdatesManager — run() as async generator", () => {
  it("yields a begin event, one call event per executed cell in topological order, then an end event", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: ["y"] },
      { id: "C", inputs: ["y"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => true,
        B: async () => true,
        C: async () => true,
      },
    });

    const stages = [];
    for await (const stage of manager.run({ signals: ["s"] })) {
      stages.push(stage);
    }

    // begin, A, B, C, end — all sharing the same transactionId
    expect(stages[0]).toEqual({ type: "begin", transactionId: 1 });
    expect(stages.at(-1)).toEqual({ type: "end", transactionId: 1 });

    const calls = stages.filter((s) => s.type === "call");
    expect(calls.map((c) => c.cellId)).toEqual(["A", "B", "C"]);
    for (const call of calls) {
      expect(call.transactionId).toBe(1);
      expect(call.updateId).toBe(0);
      expect(call.result).toBe(true);
    }
  });

  it("reports `result: false` on a handler that returned false, and `result: false` on a handler that threw", async () => {
    const graph = new DataflowGraph([
      { id: "Falsey", inputs: ["s"], outputs: [] },
      { id: "Thrower", inputs: ["s"], outputs: [] },
      { id: "Ok", inputs: ["s"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        Falsey: async () => false,
        Thrower: async () => {
          throw new Error("nope");
        },
        Ok: async () => true,
      },
      onError: () => {
        /* swallow */
      },
    });

    const byCell = new Map<string, boolean>();
    for await (const stage of manager.run({ signals: ["s"] })) {
      if (stage.type === "call") byCell.set(stage.cellId, stage.result);
    }

    expect(byCell.get("Falsey")).toBe(false);
    expect(byCell.get("Thrower")).toBe(false);
    expect(byCell.get("Ok")).toBe(true);
  });

  it("the call event's `updateId` carries the cell's prior successful tx (and 0 on first activation)", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["s"], outputs: [] }]);
    const store = new InMemoryTransactionStore();
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: { A: async () => true },
    });

    const firstStages = [];
    for await (const stage of manager.run({ signals: ["s"] })) firstStages.push(stage);
    const firstCall = firstStages.find((s) => s.type === "call");
    expect(firstCall?.updateId).toBe(0);

    const secondStages = [];
    for await (const stage of manager.run({ signals: ["s"] })) secondStages.push(stage);
    const secondCall = secondStages.find((s) => s.type === "call");
    expect(secondCall?.updateId).toBe(1); // the prior successful tx
  });

  it("pauses between yields — the caller can drive the activation one stage at a time", async () => {
    // Each cell's handler bumps a side-effect counter. We step the generator
    // manually and verify the side effects happen exactly when we advance.
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: ["y"] },
      { id: "C", inputs: ["y"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    let aRan = 0;
    let bRan = 0;
    let cRan = 0;
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          aRan++;
          return true;
        },
        B: async () => {
          bRan++;
          return true;
        },
        C: async () => {
          cRan++;
          return true;
        },
      },
    });

    const it = manager.run({ signals: ["s"] });

    // First yield: begin. No handler has run yet.
    let next = await it.next();
    expect(next.value).toEqual({ type: "begin", transactionId: 1 });
    expect(aRan).toBe(0);
    expect(bRan).toBe(0);
    expect(cRan).toBe(0);

    // Second yield: A's call event. A ran. B/C did NOT (we haven't advanced).
    next = await it.next();
    expect(next.value).toMatchObject({ type: "call", cellId: "A", result: true });
    expect(aRan).toBe(1);
    expect(bRan).toBe(0);
    expect(cRan).toBe(0);

    // Third yield: B's call event.
    next = await it.next();
    expect(next.value).toMatchObject({ type: "call", cellId: "B", result: true });
    expect(bRan).toBe(1);
    expect(cRan).toBe(0);

    // Fourth yield: C's call event.
    next = await it.next();
    expect(next.value).toMatchObject({ type: "call", cellId: "C", result: true });
    expect(cRan).toBe(1);

    // Fifth yield: end event.
    next = await it.next();
    expect(next.value).toEqual({ type: "end", transactionId: 1 });

    // Done.
    next = await it.next();
    expect(next.done).toBe(true);
  });

  it("caller can stop iterating early via generator.return() — finally still releases the in-flight guard", async () => {
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    const store = new InMemoryTransactionStore();
    let bRan = false;
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => true,
        B: async () => {
          bRan = true;
          return true;
        },
      },
    });

    const it = manager.run({ signals: ["s"] });
    await it.next(); // begin
    await it.next(); // A's call
    await it.return(undefined); // abandon iteration

    // B never ran — we closed the generator before it was reached.
    expect(bRan).toBe(false);
    // The in-flight guard is released — a fresh exec can start.
    await expect(manager.exec({ signals: ["s"] })).resolves.toBeUndefined();
    expect(bRan).toBe(true);
  });

  it("can restart from explicit cell ids — runs those cells and their downstream cascade", async () => {
    // Failed-cell restart scenario: A's handler returns false on the first
    // activation; on a fresh activation seeded with `{ cells: ["A"] }`, A and
    // its downstream B should run again.
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
      { id: "C", inputs: ["other"], outputs: [] }, // unrelated, must NOT run
    ]);
    const store = new InMemoryTransactionStore();
    let aAttempts = 0;
    let bAttempts = 0;
    let cAttempts = 0;
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          aAttempts++;
          return aAttempts > 1; // first attempt fails
        },
        B: async () => {
          bAttempts++;
          return true;
        },
        C: async () => {
          cAttempts++;
          return true;
        },
      },
    });

    // First activation via signal seed.
    const incompleteCells: string[] = [];
    for await (const stage of manager.run({ signals: ["s"] })) {
      if (stage.type === "call" && !stage.result) incompleteCells.push(stage.cellId);
    }
    expect(incompleteCells).toEqual(["A"]);
    expect(aAttempts).toBe(1);
    expect(bAttempts).toBe(1); // B still ran (downstream of failed A)
    expect(await store.getCellTransaction("A")).toBe(0); // not recorded
    expect(await store.getCellTransaction("B")).toBe(1); // B succeeded

    // Restart from the failed cells. A succeeds this time; B re-runs as
    // downstream. C is untouched.
    await manager.exec({ cells: incompleteCells });
    expect(aAttempts).toBe(2);
    expect(bAttempts).toBe(2);
    expect(cAttempts).toBe(0);
    expect(await store.getCellTransaction("A")).toBe(2);
  });

  it("cell-seeded run includes the seeded cells in topological order with the rest", async () => {
    // Seed cells from different layers. The result must respect graph order.
    const graph = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
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

    // Seed with A and C — B is in between. Forward propagation from A's
    // outputs pulls B in; topo sort then places A → B → C.
    await manager.exec({ cells: ["A", "C"] });
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("cell-seeded run silently drops unknown cell ids", async () => {
    const graph = new DataflowGraph([{ id: "A", inputs: ["s"], outputs: [] }]);
    const store = new InMemoryTransactionStore();
    let aRan = false;
    const manager = new UpdatesManager({
      graph,
      store,
      handlers: {
        A: async () => {
          aRan = true;
          return true;
        },
      },
    });

    await manager.exec({ cells: ["A", "NotARealCell"] });
    expect(aRan).toBe(true);
  });
});
