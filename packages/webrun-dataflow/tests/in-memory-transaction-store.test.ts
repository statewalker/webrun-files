import { describe, expect, it } from "vitest";
import { InMemoryTransactionStore } from "../src/in-memory-transaction-store.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("InMemoryTransactionStore — newTransactionId", () => {
  it("returns strictly increasing values starting at 1", async () => {
    const store = new InMemoryTransactionStore();
    expect(await store.newTransactionId()).toBe(1);
    expect(await store.newTransactionId()).toBe(2);
    expect(await store.newTransactionId()).toBe(3);
  });

  it("never repeats across many calls", async () => {
    const store = new InMemoryTransactionStore();
    const ids = new Set<number>();
    for (let i = 0; i < 1000; i++) ids.add(await store.newTransactionId());
    expect(ids.size).toBe(1000);
  });

  it("is independent across instances", async () => {
    const a = new InMemoryTransactionStore();
    const b = new InMemoryTransactionStore();
    await a.newTransactionId();
    await a.newTransactionId();
    expect(await b.newTransactionId()).toBe(1);
  });
});

describe("InMemoryTransactionStore — getCellTransaction", () => {
  it("returns 0 for an unknown cell", async () => {
    const store = new InMemoryTransactionStore();
    expect(await store.getCellTransaction("unknown")).toBe(0);
  });

  it("returns the value last set", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 5);
    expect(await store.getCellTransaction("A")).toBe(5);
  });

  it("setCellTransaction overwrites", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 5);
    await store.setCellTransaction("A", 12);
    expect(await store.getCellTransaction("A")).toBe(12);
  });

  it("isolates cells from each other", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 5);
    await store.setCellTransaction("B", 7);
    expect(await store.getCellTransaction("A")).toBe(5);
    expect(await store.getCellTransaction("B")).toBe(7);
  });
});

describe("InMemoryTransactionStore — getCellsTransactions", () => {
  it("yields nothing when store is empty", async () => {
    const store = new InMemoryTransactionStore();
    expect(await collect(store.getCellsTransactions())).toEqual([]);
    expect(await collect(store.getCellsTransactions(0))).toEqual([]);
  });

  it("yields all recorded cells when sinceTransactionId is omitted", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 1);
    await store.setCellTransaction("B", 2);
    await store.setCellTransaction("C", 3);

    const all = await collect(store.getCellsTransactions());
    expect(new Set(all)).toEqual(
      new Set<[string, number]>([
        ["A", 1],
        ["B", 2],
        ["C", 3],
      ]),
    );
  });

  it("filters strictly: yields only cells with tx > sinceTransactionId", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 1);
    await store.setCellTransaction("B", 5);
    await store.setCellTransaction("C", 5);
    await store.setCellTransaction("D", 9);

    const since5 = await collect(store.getCellsTransactions(5));
    expect(new Set(since5)).toEqual(new Set<[string, number]>([["D", 9]]));
  });

  it("treats sinceTransactionId of 0 as 'all with strictly positive tx'", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 1);
    await store.setCellTransaction("B", 2);

    const since0 = await collect(store.getCellsTransactions(0));
    expect(new Set(since0)).toEqual(
      new Set<[string, number]>([
        ["A", 1],
        ["B", 2],
      ]),
    );
  });
});

describe("InMemoryTransactionStore — removeCellTransactions", () => {
  it("removes a recorded cell so getCellTransaction returns 0", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 7);
    await store.removeCellTransactions("A");
    expect(await store.getCellTransaction("A")).toBe(0);
  });

  it("excludes the removed cell from getCellsTransactions iteration", async () => {
    const store = new InMemoryTransactionStore();
    await store.setCellTransaction("A", 1);
    await store.setCellTransaction("B", 2);
    await store.removeCellTransactions("A");

    const all = await collect(store.getCellsTransactions());
    expect(new Set(all)).toEqual(new Set<[string, number]>([["B", 2]]));
  });

  it("is a no-op for an unknown cell", async () => {
    const store = new InMemoryTransactionStore();
    await expect(store.removeCellTransactions("missing")).resolves.toBeUndefined();
  });
});
