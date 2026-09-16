import { describe, expect, it } from "vitest";
import { comparePaths, type FileInfo, listInPathOrder, mergeInPathOrder } from "../src/index.js";

/** The reference order: UTF-8 bytes. */
const byUtf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const dir = (path: string): FileInfo => ({
  kind: "directory",
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
});
const file = (path: string): FileInfo => ({
  kind: "file",
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  size: 1,
  lastModified: 1,
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("comparePaths", () => {
  const samples = [
    "",
    "/",
    "/t",
    "/t/B",
    "/t/a",
    "/t/a b.txt",
    "/t/a-x",
    "/t/a.txt",
    "/t/a/b.txt",
    "/t/a0",
    "/t/b",
    "/t/é.txt",
    "/t/",
    "/t/�.txt",
    "/t/😀.txt",
    "/t/😀😀",
    "/t/\u{10FFFF}",
  ];

  it("orders by code point, which is UTF-8 byte order", () => {
    for (const a of samples) {
      for (const b of samples) {
        expect(Math.sign(comparePaths(a, b)), `${a} vs ${b}`).toBe(Math.sign(byUtf8(a, b)));
      }
    }
  });

  it("differs from JavaScript's < exactly where surrogate pairs meet U+E000–U+FFFF", () => {
    expect("/t/😀.txt" < "/t/�.txt").toBe(true);
    expect(comparePaths("/t/😀.txt", "/t/�.txt")).toBeGreaterThan(0);
  });

  it("puts a prefix first, and sorts '-' and '.' before '/'", () => {
    const sorted = ["/t/a/b.txt", "/t/a.txt", "/t/a", "/t/a-x"].sort(comparePaths);
    expect(sorted).toEqual(["/t/a", "/t/a-x", "/t/a.txt", "/t/a/b.txt"]);
  });
});

/** A tree given as directory → direct children, counting which directories were read. */
function tree(entries: Record<string, FileInfo[]>) {
  const read: string[] = [];
  const children = async (path: string) => {
    read.push(path);
    // Deliberately unsorted: the walker must not rely on the backend's order.
    return [...(entries[path] ?? [])].reverse();
  };
  return { read, children };
}

const TREE = {
  "/t": [
    dir("/t/a"),
    file("/t/a-x"),
    file("/t/a.txt"),
    dir("/t/b"),
    file("/t/😀.txt"),
    file("/t/�.txt"),
  ],
  "/t/a": [file("/t/a/z"), dir("/t/a/c"), file("/t/a/b.txt")],
  "/t/a/c": [file("/t/a/c/d.txt")],
  "/t/b": [],
};
const RECURSIVE = [
  "/t/a",
  "/t/a-x",
  "/t/a.txt",
  "/t/a/b.txt",
  "/t/a/c",
  "/t/a/c/d.txt",
  "/t/a/z",
  "/t/b",
  "/t/�.txt",
  "/t/😀.txt",
];

describe("listInPathOrder", () => {
  it("lists direct children in path order", async () => {
    const { children } = tree(TREE);
    const paths = (await collect(listInPathOrder("/t", children))).map((e) => e.path);
    expect(paths).toEqual(["/t/a", "/t/a-x", "/t/a.txt", "/t/b", "/t/�.txt", "/t/😀.txt"]);
  });

  it("lists recursively in full-path order, not depth-first", async () => {
    const { children } = tree(TREE);
    const paths = (await collect(listInPathOrder("/t", children, { recursive: true }))).map(
      (e) => e.path,
    );
    expect(paths).toEqual(RECURSIVE);
  });

  it("yields exactly the suffix after any cursor, existing or not", async () => {
    const cursors = [
      ...RECURSIVE,
      "/",
      "/s",
      "/t",
      "/t/a!",
      "/t/a/bb",
      "/t/a/c/",
      "/u",
      "/t/😀.txu",
    ];
    for (const after of cursors) {
      const { children } = tree(TREE);
      const paths = (
        await collect(listInPathOrder("/t", children, { recursive: true, after }))
      ).map((e) => e.path);
      expect(paths, `after ${after}`).toEqual(RECURSIVE.filter((p) => comparePaths(p, after) > 0));
    }
  });

  it("does not read directories whose whole subtree lies at or before the cursor", async () => {
    const { children, read } = tree(TREE);
    // "/t/a" must be read: "/t/a/zz" could follow the cursor. "/t/a/c" cannot.
    await collect(listInPathOrder("/t", children, { recursive: true, after: "/t/a/z" }));
    expect(read).toEqual(["/t", "/t/a", "/t/b"]);
  });

  it("reads a directory's children only when the listing reaches it", async () => {
    const { children, read } = tree(TREE);
    const it = listInPathOrder("/t", children, { recursive: true })[Symbol.asyncIterator]();
    await it.next(); // "/t/a"
    expect(read).toEqual(["/t"]);
    await it.next();
    expect(read).toEqual(["/t", "/t/a"]);
  });
});

describe("mergeInPathOrder", () => {
  async function* stream(paths: string[], pulled: string[] = []) {
    for (const p of paths) {
      pulled.push(p);
      yield file(p);
    }
  }

  it("merges ordered streams into one ordered stream", async () => {
    const merged = mergeInPathOrder([
      stream(["/a", "/a/b", "/c"]),
      stream(["/a-x", "/b"]),
      stream([]),
      stream(["/😀"]),
    ]);
    expect((await collect(merged)).map((e) => e.path)).toEqual([
      "/a",
      "/a-x",
      "/a/b",
      "/b",
      "/c",
      "/😀",
    ]);
  });

  it("keeps the first stream's entry when paths collide", async () => {
    const first = mergeInPathOrder([
      (async function* () {
        yield dir("/x");
      })(),
      stream(["/x"]),
    ]);
    expect((await collect(first)).map((e) => e.kind)).toEqual(["directory"]);
  });

  it("pulls one entry per stream ahead at most", async () => {
    const pulledA: string[] = [];
    const pulledB: string[] = [];
    const it = mergeInPathOrder([
      stream(["/a", "/c", "/e"], pulledA),
      stream(["/b", "/d"], pulledB),
    ])[Symbol.asyncIterator]();
    expect((await it.next()).value?.path).toBe("/a");
    expect(pulledA.length + pulledB.length).toBeLessThanOrEqual(3);
  });

  it("closes every stream when the consumer stops", async () => {
    const closed: string[] = [];
    const tracked = (name: string, paths: string[]) =>
      (async function* () {
        try {
          yield* stream(paths);
        } finally {
          closed.push(name);
        }
      })();
    for await (const _ of mergeInPathOrder([tracked("a", ["/a", "/c"]), tracked("b", ["/b"])]))
      break;
    expect(closed.sort()).toEqual(["a", "b"]);
  });
});
