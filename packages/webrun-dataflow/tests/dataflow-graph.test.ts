import { describe, expect, it } from "vitest";
import { DataflowGraph } from "../src/dataflow-graph.js";
import type { CellDefinition, CellId } from "../src/types.js";

/**
 * Helpers
 */
function indexOf(order: CellId[], id: CellId): number {
  const i = order.indexOf(id);
  if (i < 0) throw new Error(`Expected "${id}" in order [${order.join(", ")}]`);
  return i;
}

function expectBefore(order: CellId[], a: CellId, b: CellId): void {
  expect(indexOf(order, a)).toBeLessThan(indexOf(order, b));
}

describe("DataflowGraph — construction", () => {
  it("rejects duplicate cell ids", () => {
    const cells: CellDefinition[] = [
      { id: "A", inputs: [], outputs: ["x"] },
      { id: "A", inputs: ["x"], outputs: [] },
    ];
    expect(() => new DataflowGraph(cells)).toThrow(/Duplicate cell id: A/);
  });

  it("indexes signal → producers and signal → consumers", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: [], outputs: ["x"] },
      { id: "B", inputs: [], outputs: ["x"] },
      { id: "C", inputs: ["x"], outputs: ["y"] },
      { id: "D", inputs: ["y"], outputs: [] },
    ]);

    expect(g.getCellsProducing("x")).toEqual(new Set(["A", "B"]));
    expect(g.getCellsProducing("y")).toEqual(new Set(["C"]));
    expect(g.getCellsConsuming("x")).toEqual(new Set(["C"]));
    expect(g.getCellsConsuming("y")).toEqual(new Set(["D"]));
    expect(g.getCellsProducing("missing")).toEqual(new Set());
  });

  it("returns input/output lists per cell", () => {
    const g = new DataflowGraph([{ id: "A", inputs: ["x", "y"], outputs: ["z"] }]);
    expect(g.getCellInputs("A")).toEqual(["x", "y"]);
    expect(g.getCellOutputs("A")).toEqual(["z"]);
    expect(g.getCellInputs("missing")).toEqual([]);
  });
});

describe("DataflowGraph — getExecutionOrder: trivial cases", () => {
  it("returns [] when no signals are changed", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: [], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    expect(g.getExecutionOrder([])).toEqual([]);
  });

  it("returns [] when changed signal has no consumers", () => {
    const g = new DataflowGraph([{ id: "A", inputs: [], outputs: ["x"] }]);
    expect(g.getExecutionOrder(["unrelated"])).toEqual([]);
  });

  it("returns single seed when seed produces nothing", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: [], outputs: ["x"] },
      { id: "C", inputs: ["x"], outputs: [] },
    ]);
    expect(g.getExecutionOrder(["x"])).toEqual(["C"]);
  });
});

describe("DataflowGraph — forward propagation", () => {
  it("walks transitively through consumers", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: ["y"] },
      { id: "C", inputs: ["y"], outputs: [] },
      { id: "D", inputs: [], outputs: [] }, // unrelated, must not appear
    ]);
    const order = g.getExecutionOrder(["s"]);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C"]));
    expectBefore(order, "A", "B");
    expectBefore(order, "B", "C");
  });

  it("does not propagate upstream when only an output signal changes", () => {
    // Even if x is produced by A, changing x externally only impacts consumers
    // of x — A itself is not re-run.
    const g = new DataflowGraph([
      { id: "A", inputs: [], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    expect(g.getExecutionOrder(["x"])).toEqual(["B"]);
  });
});

describe("DataflowGraph — barrier semantics with multiple producers", () => {
  it("schedules a consumer after ALL impacted producers of its inputs", () => {
    // A→x, B→x, C reads x. Triggering s only includes A (and C),
    // so C must run after A — but B is not in this run.
    const g = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: [], outputs: ["x"] },
      { id: "C", inputs: ["x"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["s"]);
    expect(new Set(order)).toEqual(new Set(["A", "C"]));
    expectBefore(order, "A", "C");
  });

  it("waits for both producers when both are impacted", () => {
    // s impacts A and B (both produce x), C reads x.
    const g = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["s"], outputs: ["x"] },
      { id: "C", inputs: ["x"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["s"]);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C"]));
    expectBefore(order, "A", "C");
    expectBefore(order, "B", "C");
    // A and B are independent — both orderings are valid.
  });

  it("ignores producers that are NOT in the impacted set when ordering", () => {
    // A→x (impacted via s), B→x (NOT impacted), C reads x.
    // C must wait for A but not for B.
    const g = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["unrelated"], outputs: ["x"] },
      { id: "C", inputs: ["x"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["s"]);
    expect(order).not.toContain("B");
    expectBefore(order, "A", "C");
  });
});

describe("DataflowGraph — diamond and fan-out shapes", () => {
  it("orders a classic diamond correctly", () => {
    //        A
    //       / \
    //      B   C
    //       \ /
    //        D
    const g = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: ["y"] },
      { id: "C", inputs: ["x"], outputs: ["z"] },
      { id: "D", inputs: ["y", "z"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["s"]);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C", "D"]));
    expectBefore(order, "A", "B");
    expectBefore(order, "A", "C");
    expectBefore(order, "B", "D");
    expectBefore(order, "C", "D");
  });

  it("includes both branches of a fan-out from one signal change", () => {
    const g = new DataflowGraph([
      { id: "ROOT", inputs: ["s"], outputs: ["x"] },
      { id: "L", inputs: ["x"], outputs: [] },
      { id: "R", inputs: ["x"], outputs: [] },
    ]);
    const order = g.getExecutionOrder(["s"]);
    expect(new Set(order)).toEqual(new Set(["ROOT", "L", "R"]));
    expectBefore(order, "ROOT", "L");
    expectBefore(order, "ROOT", "R");
  });
});

describe("DataflowGraph — multiple changed signals", () => {
  it("merges seed sets without duplicating cells", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: ["s1", "s2"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
    ]);
    const order = g.getExecutionOrder(["s1", "s2"]);
    expect(order).toEqual(["A", "B"]);
  });

  it("seeds multiple disjoint consumers from different signals", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: ["s1"], outputs: [] },
      { id: "B", inputs: ["s2"], outputs: [] },
      { id: "C", inputs: ["s3"], outputs: [] },
    ]);
    expect(new Set(g.getExecutionOrder(["s1", "s2"]))).toEqual(new Set(["A", "B"]));
  });
});

describe("DataflowGraph — cycle detection", () => {
  it("throws if the impacted subgraph contains a cycle", () => {
    // A reads x, writes y; B reads y, writes x — true cycle.
    const g = new DataflowGraph([
      { id: "SEED", inputs: ["s"], outputs: ["x"] },
      { id: "A", inputs: ["x"], outputs: ["y"] },
      { id: "B", inputs: ["y"], outputs: ["x"] },
    ]);
    expect(() => g.getExecutionOrder(["s"])).toThrow(/Cycle detected/);
  });

  it("reports only the cells actually in the cycle, not downstream consumers of it", () => {
    // CYC_A and CYC_B form a cycle via signals x/y.
    // DOWN reads x but never feeds back into the cycle — it is downstream
    // of the cycle, not a member of it. The error must NOT list DOWN.
    const g = new DataflowGraph([
      { id: "CYC_A", inputs: ["y"], outputs: ["x"] },
      { id: "CYC_B", inputs: ["x"], outputs: ["y"] },
      { id: "DOWN", inputs: ["x"], outputs: [] },
    ]);
    let thrown: unknown;
    try {
      g.getExecutionOrder(["x"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/Cycle detected/);
    expect(message).toContain("CYC_A");
    expect(message).toContain("CYC_B");
    expect(message).not.toContain("DOWN");
  });

  it("does NOT throw if a cycle exists outside the impacted subgraph", () => {
    // Cycle is on signals p/q, but the run only touches A→B.
    const g = new DataflowGraph([
      { id: "A", inputs: ["s"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
      { id: "CYC1", inputs: ["p"], outputs: ["q"] },
      { id: "CYC2", inputs: ["q"], outputs: ["p"] },
    ]);
    expect(() => g.getExecutionOrder(["s"])).not.toThrow();
  });
});

describe("DataflowGraph — defensive copies", () => {
  it("returns fresh sets / arrays so callers cannot mutate internals", () => {
    const g = new DataflowGraph([{ id: "A", inputs: ["x"], outputs: ["y"] }]);

    const consumers = g.getCellsConsuming("x");
    consumers.add("HACKED");
    expect(g.getCellsConsuming("x")).toEqual(new Set(["A"]));

    const producers = g.getCellsProducing("y");
    producers.clear();
    expect(g.getCellsProducing("y")).toEqual(new Set(["A"]));

    const inputs = g.getCellInputs("A");
    inputs.push("HACKED");
    expect(g.getCellInputs("A")).toEqual(["x"]);
  });
});
