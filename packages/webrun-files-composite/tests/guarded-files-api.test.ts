import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { beforeEach, describe, expect, it } from "vitest";
import type { FileGuard } from "../src/index.js";
import { GuardedFilesApi } from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  if (chunks.length === 0) return "";
  const total = chunks.reduce((acc, b) => acc + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(result);
}

async function collectEntries<T extends { name: string; path: string; kind: string }>(
  stream: AsyncIterable<T>,
): Promise<T[]> {
  const result: T[] = [];
  for await (const entry of stream) result.push(entry);
  return result;
}

// ---------------------------------------------------------------
// Shared FilesApi suite — empty guard list must behave like the source
// ---------------------------------------------------------------

createFilesApiTests("GuardedFilesApi (no guards)", async () => ({
  api: new GuardedFilesApi(new MemFilesApi(), []),
}));

createFilesApiTests("GuardedFilesApi (always-allow guard)", async () => ({
  api: new GuardedFilesApi(new MemFilesApi(), [
    {
      operations: ["read", "write", "mkdir", "list", "remove", "move", "copy"],
      check: () => true,
    },
  ]),
}));

// ---------------------------------------------------------------
// Per-operation guard enforcement
// ---------------------------------------------------------------

describe("GuardedFilesApi - read", () => {
  let source: MemFilesApi;
  let api: GuardedFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/public.txt", [toBytes("ok")]);
    await source.write("/secret/data.txt", [toBytes("nope")]);
    api = new GuardedFilesApi(source, [
      {
        operations: ["read"],
        check: (p) => !p.startsWith("/secret"),
        message: "no read",
      },
    ]);
  });

  it("allows read on permitted paths", async () => {
    expect(await readAll(api.read("/public.txt"))).toBe("ok");
  });

  it("throws synchronously from read iterator on denied paths", () => {
    expect(() => api.read("/secret/data.txt")).toThrow(/no read: \/secret\/data\.txt/);
  });
});

describe("GuardedFilesApi - write", () => {
  let source: MemFilesApi;
  let api: GuardedFilesApi;

  beforeEach(() => {
    source = new MemFilesApi();
    api = new GuardedFilesApi(source, [
      {
        operations: ["write"],
        check: (p) => !p.startsWith("/locked"),
        message: "locked",
      },
    ]);
  });

  it("allows write to permitted paths", async () => {
    await api.write("/free.txt", [toBytes("yes")]);
    expect(await readAll(source.read("/free.txt"))).toBe("yes");
  });

  it("throws on denied paths and does not write to source", async () => {
    await expect(api.write("/locked/file.txt", [toBytes("x")])).rejects.toThrow(
      "locked: /locked/file.txt",
    );
    expect(await source.exists("/locked/file.txt")).toBe(false);
  });
});

describe("GuardedFilesApi - mkdir", () => {
  let source: MemFilesApi;
  let api: GuardedFilesApi;

  beforeEach(() => {
    source = new MemFilesApi();
    api = new GuardedFilesApi(source, [
      {
        operations: ["mkdir"],
        check: (p) => !p.startsWith("/no-dirs"),
      },
    ]);
  });

  it("allows mkdir on permitted paths", async () => {
    await api.mkdir("/ok");
    expect(await source.exists("/ok")).toBe(true);
  });

  it("throws on denied paths", async () => {
    await expect(api.mkdir("/no-dirs/x")).rejects.toThrow(/Access denied: \/no-dirs\/x/);
  });
});

describe("GuardedFilesApi - list", () => {
  it("allows listing of permitted paths and yields file entries", async () => {
    const source = new MemFilesApi();
    await source.write("/a.txt", [toBytes("a")]);
    await source.write("/b.txt", [toBytes("b")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["list"], check: (p) => !p.startsWith("/private"), message: "no listing" },
    ]);
    const names = (await collectEntries(api.list("/"))).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
  });

  it("throws when iterating reaches a directory entry blocked by list guard", async () => {
    const source = new MemFilesApi();
    await source.write("/a.txt", [toBytes("a")]);
    await source.write("/private/b.txt", [toBytes("b")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["list"], check: (p) => !p.startsWith("/private"), message: "no listing" },
    ]);
    await expect(collectEntries(api.list("/"))).rejects.toThrow(/no listing/);
  });

  it("calling list on a denied path throws once iteration begins", async () => {
    const source = new MemFilesApi();
    await source.write("/private/b.txt", [toBytes("b")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["list"], check: (p) => !p.startsWith("/private"), message: "no listing" },
    ]);
    await expect(collectEntries(api.list("/private"))).rejects.toThrow(/no listing: \/private/);
  });
});

describe("GuardedFilesApi - stats checks list operation", () => {
  it("stats throws when list is denied for the path", async () => {
    const source = new MemFilesApi();
    await source.write("/x.txt", [toBytes("x")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["list"], check: (p) => p !== "/x.txt", message: "blocked" },
    ]);
    expect(() => api.stats("/x.txt")).toThrow("blocked: /x.txt");
  });

  it("stats succeeds when no list-blocking guard matches", async () => {
    const source = new MemFilesApi();
    await source.write("/x.txt", [toBytes("x")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["write"], check: () => false, message: "deny-write" },
    ]);
    const s = await api.stats("/x.txt");
    expect(s?.kind).toBe("file");
  });
});

describe("GuardedFilesApi - exists checks read operation", () => {
  it("exists throws when read is denied for the path", async () => {
    const source = new MemFilesApi();
    await source.write("/x.txt", [toBytes("x")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["read"], check: (p) => p !== "/x.txt", message: "blocked" },
    ]);
    expect(() => api.exists("/x.txt")).toThrow("blocked: /x.txt");
  });

  it("exists succeeds when no read-blocking guard matches", async () => {
    const source = new MemFilesApi();
    await source.write("/x.txt", [toBytes("x")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["write"], check: () => false, message: "deny-write" },
    ]);
    expect(await api.exists("/x.txt")).toBe(true);
  });
});

describe("GuardedFilesApi - remove", () => {
  let source: MemFilesApi;
  let api: GuardedFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/keep.txt", [toBytes("k")]);
    await source.write("/system/file.txt", [toBytes("s")]);
    api = new GuardedFilesApi(source, [
      {
        operations: ["remove"],
        check: (p) => !p.startsWith("/system"),
        message: "system protected",
      },
    ]);
  });

  it("removes permitted paths", async () => {
    expect(await api.remove("/keep.txt")).toBe(true);
    expect(await source.exists("/keep.txt")).toBe(false);
  });

  it("throws on denied paths and does not delete from source", async () => {
    await expect(api.remove("/system/file.txt")).rejects.toThrow("system protected");
    expect(await source.exists("/system/file.txt")).toBe(true);
  });
});

describe("GuardedFilesApi - move", () => {
  let source: MemFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/a.txt", [toBytes("a")]);
    await source.write("/locked/b.txt", [toBytes("b")]);
  });

  it("allowed move succeeds", async () => {
    const api = new GuardedFilesApi(source, []);
    expect(await api.move("/a.txt", "/c.txt")).toBe(true);
    expect(await source.exists("/a.txt")).toBe(false);
    expect(await readAll(source.read("/c.txt"))).toBe("a");
  });

  it("blocked by move guard on source", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["move"], check: (p) => !p.startsWith("/locked"), message: "locked" },
    ]);
    await expect(api.move("/locked/b.txt", "/c.txt")).rejects.toThrow("locked: /locked/b.txt");
    expect(await source.exists("/locked/b.txt")).toBe(true);
  });

  it("blocked by move guard on target", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["move"], check: (p) => !p.startsWith("/locked"), message: "locked" },
    ]);
    await expect(api.move("/a.txt", "/locked/c.txt")).rejects.toThrow("locked: /locked/c.txt");
    expect(await source.exists("/a.txt")).toBe(true);
  });

  it("blocked by read guard on source (move semantically reads source)", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["read"], check: (p) => !p.startsWith("/locked"), message: "no-read" },
    ]);
    await expect(api.move("/locked/b.txt", "/c.txt")).rejects.toThrow("no-read: /locked/b.txt");
  });

  it("blocked by write guard on target (move semantically writes target)", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["write"], check: (p) => !p.startsWith("/locked"), message: "no-write" },
    ]);
    await expect(api.move("/a.txt", "/locked/c.txt")).rejects.toThrow("no-write: /locked/c.txt");
  });
});

describe("GuardedFilesApi - copy", () => {
  let source: MemFilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await source.write("/a.txt", [toBytes("a")]);
    await source.write("/locked/b.txt", [toBytes("b")]);
  });

  it("allowed copy succeeds", async () => {
    const api = new GuardedFilesApi(source, []);
    expect(await api.copy("/a.txt", "/c.txt")).toBe(true);
    expect(await readAll(source.read("/a.txt"))).toBe("a");
    expect(await readAll(source.read("/c.txt"))).toBe("a");
  });

  it("blocked by copy guard on source", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["copy"], check: (p) => !p.startsWith("/locked"), message: "locked" },
    ]);
    await expect(api.copy("/locked/b.txt", "/c.txt")).rejects.toThrow("locked: /locked/b.txt");
    expect(await source.exists("/c.txt")).toBe(false);
  });

  it("blocked by copy guard on target", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["copy"], check: (p) => !p.startsWith("/locked"), message: "locked" },
    ]);
    await expect(api.copy("/a.txt", "/locked/c.txt")).rejects.toThrow("locked: /locked/c.txt");
    expect(await source.exists("/locked/c.txt")).toBe(false);
  });

  it("blocked by read guard on source", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["read"], check: (p) => !p.startsWith("/locked"), message: "no-read" },
    ]);
    await expect(api.copy("/locked/b.txt", "/c.txt")).rejects.toThrow("no-read: /locked/b.txt");
  });

  it("blocked by write guard on target", async () => {
    const api = new GuardedFilesApi(source, [
      { operations: ["write"], check: (p) => !p.startsWith("/locked"), message: "no-write" },
    ]);
    await expect(api.copy("/a.txt", "/locked/c.txt")).rejects.toThrow("no-write: /locked/c.txt");
  });
});

// ---------------------------------------------------------------
// Multi-guard composition
// ---------------------------------------------------------------

describe("GuardedFilesApi - multiple guards", () => {
  it("first denial wins", async () => {
    const source = new MemFilesApi();
    const api = new GuardedFilesApi(source, [
      { operations: ["write"], check: (p) => !p.startsWith("/a/"), message: "Guard A" },
      { operations: ["write"], check: (p) => !p.startsWith("/b/"), message: "Guard B" },
    ]);
    await expect(api.write("/a/x.txt", [toBytes("x")])).rejects.toThrow("Guard A: /a/x.txt");
    await expect(api.write("/b/x.txt", [toBytes("x")])).rejects.toThrow("Guard B: /b/x.txt");
    await expect(api.write("/a/b/x.txt", [toBytes("x")])).rejects.toThrow("Guard A: /a/b/x.txt");
  });

  it("guards only apply to listed operations", async () => {
    const source = new MemFilesApi();
    await source.write("/data.txt", [toBytes("v")]);
    const api = new GuardedFilesApi(source, [
      { operations: ["write", "remove"], check: () => false, message: "no-mutate" },
    ]);
    // read is not in the operations list → allowed
    expect(await readAll(api.read("/data.txt"))).toBe("v");
    // write IS in the operations list → blocked
    await expect(api.write("/data.txt", [toBytes("x")])).rejects.toThrow("no-mutate");
  });

  it("uses default 'Access denied' message when none provided", async () => {
    const api = new GuardedFilesApi(new MemFilesApi(), [
      { operations: ["write"], check: () => false },
    ]);
    await expect(api.write("/x.txt", [toBytes("x")])).rejects.toThrow("Access denied: /x.txt");
  });
});

// ---------------------------------------------------------------
// Path normalization in guard checks
// ---------------------------------------------------------------

describe("GuardedFilesApi - path normalization", () => {
  it("guard check receives normalized path (single leading slash, no trailing)", async () => {
    const seen: string[] = [];
    const api = new GuardedFilesApi(new MemFilesApi(), [
      {
        operations: ["write"],
        check: (p) => {
          seen.push(p);
          return true;
        },
      },
    ]);
    await api.write("foo/bar/", [toBytes("x")]);
    await api.write("//foo//bar//", [toBytes("x")]);
    expect(seen).toEqual(["/foo/bar", "/foo/bar"]);
  });

  it("error message uses the normalized path", async () => {
    const api = new GuardedFilesApi(new MemFilesApi(), [
      { operations: ["write"], check: () => false, message: "no" },
    ]);
    await expect(api.write("foo//bar/", [toBytes("x")])).rejects.toThrow("no: /foo/bar");
  });
});

// ---------------------------------------------------------------
// Guard list isolation (defensive copy)
// ---------------------------------------------------------------

describe("GuardedFilesApi - guard list defensive copy", () => {
  it("mutating the guards array after construction does not affect the wrapper", async () => {
    const source = new MemFilesApi();
    const guards: FileGuard[] = [{ operations: ["write"], check: () => false, message: "denied" }];
    const api = new GuardedFilesApi(source, guards);
    guards.length = 0; // remove all guards from caller's array
    await expect(api.write("/x.txt", [toBytes("x")])).rejects.toThrow("denied");
  });
});
