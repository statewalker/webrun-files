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
      { id: "A", inputs: [], outputs: ["X"] },
      { id: "A", inputs: ["X"], outputs: [] },
    ];
    expect(() => new DataflowGraph(cells)).toThrow(/Duplicate cell id: A/);
  });

  it("indexes signal → producers and signal → consumers", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: [], outputs: ["X"] },
      { id: "B", inputs: [], outputs: ["X"] },
      { id: "C", inputs: ["X"], outputs: ["Y"] },
      { id: "D", inputs: ["Y"], outputs: [] },
    ]);

    expect(g.getCellsProducing("X")).toEqual(new Set(["A", "B"]));
    expect(g.getCellsProducing("Y")).toEqual(new Set(["C"]));
    expect(g.getCellsConsuming("X")).toEqual(new Set(["C"]));
    expect(g.getCellsConsuming("Y")).toEqual(new Set(["D"]));
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
      { id: "A", inputs: [], outputs: ["X"] },
      { id: "B", inputs: ["X"], outputs: [] },
    ]);
    expect(g.getExecutionOrder([])).toEqual([]);
  });

  it("returns [] when changed signal has no consumers", () => {
    const g = new DataflowGraph([{ id: "A", inputs: [], outputs: ["X"] }]);
    expect(g.getExecutionOrder(["unrelated"])).toEqual([]);
  });

  it("returns single seed when seed produces nothing", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: [], outputs: ["X"] },
      { id: "C", inputs: ["X"], outputs: [] },
    ]);
    expect(g.getExecutionOrder(["X"])).toEqual(["C"]);
  });
});

describe("DataflowGraph — forward propagation", () => {
  it("walks transitively through consumers", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["X"] },
      { id: "B", inputs: ["X"], outputs: ["Y"] },
      { id: "C", inputs: ["Y"], outputs: [] },
      { id: "D", inputs: [], outputs: [] }, // unrelated, must not appear
    ]);
    const order = g.getExecutionOrder(["S"]);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C"]));
    expectBefore(order, "A", "B");
    expectBefore(order, "B", "C");
  });

  it("does not propagate upstream when only an output signal changes", () => {
    // Even if X is produced by A, changing X externally only impacts consumers
    // of X — A itself is not re-run.
    const g = new DataflowGraph([
      { id: "A", inputs: [], outputs: ["X"] },
      { id: "B", inputs: ["X"], outputs: [] },
    ]);
    expect(g.getExecutionOrder(["X"])).toEqual(["B"]);
  });
});

describe("DataflowGraph — barrier semantics with multiple producers", () => {
  it("schedules a consumer after ALL impacted producers of its inputs", () => {
    // A→X, B→X, C reads X. Triggering S only includes A (and C),
    // so C must run after A — but B is not in this run.
    const g = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["X"] },
      { id: "B", inputs: [], outputs: ["X"] },
      { id: "C", inputs: ["X"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["S"]);
    expect(new Set(order)).toEqual(new Set(["A", "C"]));
    expectBefore(order, "A", "C");
  });

  it("waits for both producers when both are impacted", () => {
    // S impacts A and B (both produce X), C reads X.
    const g = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["X"] },
      { id: "B", inputs: ["S"], outputs: ["X"] },
      { id: "C", inputs: ["X"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["S"]);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C"]));
    expectBefore(order, "A", "C");
    expectBefore(order, "B", "C");
    // A and B are independent — both orderings are valid.
  });

  it("ignores producers that are NOT in the impacted set when ordering", () => {
    // A→X (impacted via S), B→X (NOT impacted), C reads X.
    // C must wait for A but not for B.
    const g = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["X"] },
      { id: "B", inputs: ["UNRELATED"], outputs: ["X"] },
      { id: "C", inputs: ["X"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["S"]);
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
      { id: "A", inputs: ["S"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: ["y"] },
      { id: "C", inputs: ["x"], outputs: ["z"] },
      { id: "D", inputs: ["y", "z"], outputs: [] },
    ]);

    const order = g.getExecutionOrder(["S"]);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C", "D"]));
    expectBefore(order, "A", "B");
    expectBefore(order, "A", "C");
    expectBefore(order, "B", "D");
    expectBefore(order, "C", "D");
  });

  it("includes both branches of a fan-out from one signal change", () => {
    const g = new DataflowGraph([
      { id: "ROOT", inputs: ["S"], outputs: ["x"] },
      { id: "L", inputs: ["x"], outputs: [] },
      { id: "R", inputs: ["x"], outputs: [] },
    ]);
    const order = g.getExecutionOrder(["S"]);
    expect(new Set(order)).toEqual(new Set(["ROOT", "L", "R"]));
    expectBefore(order, "ROOT", "L");
    expectBefore(order, "ROOT", "R");
  });
});

describe("DataflowGraph — multiple changed signals", () => {
  it("merges seed sets without duplicating cells", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: ["S1", "S2"], outputs: ["X"] },
      { id: "B", inputs: ["X"], outputs: [] },
    ]);
    const order = g.getExecutionOrder(["S1", "S2"]);
    expect(order).toEqual(["A", "B"]);
  });

  it("seeds multiple disjoint consumers from different signals", () => {
    const g = new DataflowGraph([
      { id: "A", inputs: ["S1"], outputs: [] },
      { id: "B", inputs: ["S2"], outputs: [] },
      { id: "C", inputs: ["S3"], outputs: [] },
    ]);
    expect(new Set(g.getExecutionOrder(["S1", "S2"]))).toEqual(new Set(["A", "B"]));
  });
});

describe("DataflowGraph — cycle detection", () => {
  it("throws if the impacted subgraph contains a cycle", () => {
    // A reads X, writes Y; B reads Y, writes X — true cycle.
    const g = new DataflowGraph([
      { id: "SEED", inputs: ["S"], outputs: ["X"] },
      { id: "A", inputs: ["X"], outputs: ["Y"] },
      { id: "B", inputs: ["Y"], outputs: ["X"] },
    ]);
    expect(() => g.getExecutionOrder(["S"])).toThrow(/Cycle detected/);
  });

  it("does NOT throw if a cycle exists outside the impacted subgraph", () => {
    // Cycle is on signals P/Q, but the run only touches A→B.
    const g = new DataflowGraph([
      { id: "A", inputs: ["S"], outputs: ["x"] },
      { id: "B", inputs: ["x"], outputs: [] },
      { id: "CYC1", inputs: ["P"], outputs: ["Q"] },
      { id: "CYC2", inputs: ["Q"], outputs: ["P"] },
    ]);
    expect(() => g.getExecutionOrder(["S"])).not.toThrow();
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
