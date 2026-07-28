import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cow, overlay, readOnly } from "../src/index.js";

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

async function names(stream: AsyncIterable<{ name: string }>): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of stream) result.push(entry.name);
  return result.sort();
}

async function write(api: FilesApi, path: string, text: string): Promise<void> {
  await api.write(path, [toBytes(text)]);
}

// ---------------------------------------------------------------
// Conformance — cow behaves like a plain FilesApi via its writable layer
// ---------------------------------------------------------------

createFilesApiTests("cow (empty base)", async () => ({
  api: cow(new MemFilesApi(), new MemFilesApi()),
}));

// Same, but the base is wrapped read-only so any accidental base mutation
// during the full conformance suite would throw and fail the run.
createFilesApiTests("cow (read-only base)", async () => ({
  api: cow(readOnly(new MemFilesApi()), new MemFilesApi()),
}));

// ---------------------------------------------------------------
// readOnly
// ---------------------------------------------------------------

describe("readOnly", () => {
  let source: MemFilesApi;
  let api: FilesApi;

  beforeEach(async () => {
    source = new MemFilesApi();
    await write(source, "/a.txt", "a");
    await write(source, "/dir/b.txt", "b");
    api = readOnly(source);
  });

  it("passes reads through", async () => {
    expect(await readAll(api.read("/a.txt"))).toBe("a");
    expect(await api.exists("/a.txt")).toBe(true);
    expect((await api.stats("/a.txt"))?.kind).toBe("file");
    expect(await names(api.list("/"))).toEqual(["a.txt", "dir"]);
  });

  it("throws on every mutation", async () => {
    await expect(api.write("/a.txt", [toBytes("x")])).rejects.toThrow();
    await expect(api.mkdir("/new")).rejects.toThrow();
    await expect(api.remove("/a.txt")).rejects.toThrow();
    await expect(api.move("/a.txt", "/c.txt")).rejects.toThrow();
    await expect(api.copy("/a.txt", "/c.txt")).rejects.toThrow();
  });

  it("does not mutate the underlying source", async () => {
    await expect(api.write("/a.txt", [toBytes("x")])).rejects.toThrow();
    expect(await readAll(source.read("/a.txt"))).toBe("a");
  });
});

// ---------------------------------------------------------------
// overlay — read-only union
// ---------------------------------------------------------------

describe("overlay", () => {
  it("falls through to a lower layer for a path only in base", async () => {
    const top = new MemFilesApi();
    const base = new MemFilesApi();
    await write(base, "/only-base.txt", "base");
    const api = overlay(top, base);
    expect(await readAll(api.read("/only-base.txt"))).toBe("base");
    expect(await api.exists("/only-base.txt")).toBe(true);
    expect((await api.stats("/only-base.txt"))?.kind).toBe("file");
  });

  it("top shadows a lower layer for content", async () => {
    const top = new MemFilesApi();
    const base = new MemFilesApi();
    await write(top, "/x.txt", "top");
    await write(base, "/x.txt", "base");
    const api = overlay(top, base);
    expect(await readAll(api.read("/x.txt"))).toBe("top");
  });

  it("list merges and dedupes across layers", async () => {
    const top = new MemFilesApi();
    const base = new MemFilesApi();
    await write(top, "/a.txt", "a");
    await write(top, "/shared.txt", "top");
    await write(base, "/shared.txt", "base");
    await write(base, "/b.txt", "b");
    const api = overlay(top, base);
    expect(await names(api.list("/"))).toEqual(["a.txt", "b.txt", "shared.txt"]);
    expect(await readAll(api.read("/shared.txt"))).toBe("top");
  });

  it("top's kind wins a file/dir clash in listings and stats", async () => {
    const top = new MemFilesApi();
    const base = new MemFilesApi();
    await write(top, "/clash", "iam-a-file"); // file in top
    await write(base, "/clash/inside.txt", "iam-a-dir"); // dir in base
    const api = overlay(top, base);
    const entries: { name: string; kind: string }[] = [];
    for await (const e of api.list("/")) entries.push(e);
    const clash = entries.find((e) => e.name === "clash");
    expect(clash?.kind).toBe("file");
    expect((await api.stats("/clash"))?.kind).toBe("file");
  });

  it("merges nested directories recursively", async () => {
    const top = new MemFilesApi();
    const base = new MemFilesApi();
    await write(top, "/dir/top-only.txt", "t");
    await write(base, "/dir/base-only.txt", "b");
    const api = overlay(top, base);
    expect(await names(api.list("/dir"))).toEqual(["base-only.txt", "top-only.txt"]);
    const rec = await names(api.list("/", { recursive: true }));
    expect(rec).toContain("top-only.txt");
    expect(rec).toContain("base-only.txt");
  });

  it("denies every write", async () => {
    const top = new MemFilesApi();
    const base = new MemFilesApi();
    const api = overlay(top, base);
    await expect(api.write("/x.txt", [toBytes("x")])).rejects.toThrow();
    await expect(api.mkdir("/d")).rejects.toThrow();
    await expect(api.remove("/x.txt")).rejects.toThrow();
    await expect(api.move("/a", "/b")).rejects.toThrow();
    await expect(api.copy("/a", "/b")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------
// cow — copy-on-write
// ---------------------------------------------------------------

describe("cow", () => {
  let base: MemFilesApi;
  let writable: MemFilesApi;
  let api: FilesApi;

  beforeEach(async () => {
    base = new MemFilesApi();
    writable = new MemFilesApi();
    await write(base, "/keep.txt", "base-keep");
    await write(base, "/shadow.txt", "base-shadow");
    await write(base, "/dir/deep.txt", "base-deep");
    api = cow(base, writable);
  });

  it("falls through to base for a base-only file", async () => {
    expect(await readAll(api.read("/keep.txt"))).toBe("base-keep");
    expect(await api.exists("/keep.txt")).toBe(true);
    expect((await api.stats("/keep.txt"))?.kind).toBe("file");
  });

  it("writable shadows the base version (content + kind)", async () => {
    await write(api, "/shadow.txt", "over");
    expect(await readAll(api.read("/shadow.txt"))).toBe("over");
    // base untouched
    expect(await readAll(base.read("/shadow.txt"))).toBe("base-shadow");

    // kind shadow: base has /clash as dir, writable writes it as a file
    await write(base, "/clash/inner.txt", "d");
    await write(api, "/clash", "now-a-file");
    expect((await api.stats("/clash"))?.kind).toBe("file");
    expect(await readAll(api.read("/clash"))).toBe("now-a-file");
  });

  it("whiteout: removing a base-only file hides it and persists", async () => {
    expect(await api.remove("/keep.txt")).toBe(true);
    expect(await readAll(api.read("/keep.txt"))).toBe("");
    expect(await api.stats("/keep.txt")).toBeUndefined();
    expect(await api.exists("/keep.txt")).toBe(false);
    expect(await names(api.list("/"))).not.toContain("keep.txt");
    // the .wh. marker itself must not leak into listings
    for (const n of await names(api.list("/"))) {
      expect(n.startsWith(".wh.")).toBe(false);
    }
    // base is untouched
    expect(await base.exists("/keep.txt")).toBe(true);
    // persistence: a fresh cow over the SAME writable still sees it deleted
    const reopened = cow(base, writable);
    expect(await reopened.exists("/keep.txt")).toBe(false);
    expect(await readAll(reopened.read("/keep.txt"))).toBe("");
  });

  it("resurrect: writing a whiteouted path clears the whiteout", async () => {
    await api.remove("/keep.txt");
    expect(await api.exists("/keep.txt")).toBe(false);
    await write(api, "/keep.txt", "back");
    expect(await api.exists("/keep.txt")).toBe(true);
    expect(await readAll(api.read("/keep.txt"))).toBe("back");
    expect(await names(api.list("/"))).toContain("keep.txt");
  });

  it("opaque dir: removing a base directory hides its whole subtree", async () => {
    await write(base, "/dir/sub/nested.txt", "n");
    expect(await api.remove("/dir")).toBe(true);
    expect(await api.exists("/dir/deep.txt")).toBe(false);
    expect(await api.exists("/dir/sub/nested.txt")).toBe(false);
    expect(await readAll(api.read("/dir/deep.txt"))).toBe("");
    expect(await names(api.list("/dir"))).toEqual([]);
    // a new child created afterwards is visible; base subtree stays hidden
    await write(api, "/dir/fresh.txt", "fresh");
    expect(await api.exists("/dir/fresh.txt")).toBe(true);
    expect(await names(api.list("/dir"))).toEqual(["fresh.txt"]);
    // base is untouched
    expect(await base.exists("/dir/deep.txt")).toBe(true);
  });

  it("move: base file a->b makes b readable, a absent, base unchanged", async () => {
    expect(await api.move("/keep.txt", "/moved.txt")).toBe(true);
    expect(await readAll(api.read("/moved.txt"))).toBe("base-keep");
    expect(await api.exists("/keep.txt")).toBe(false);
    // base is untouched
    expect(await base.exists("/keep.txt")).toBe(true);
    expect(await base.exists("/moved.txt")).toBe(false);
  });

  it("list merges base + writable, dedupes, writable kind wins a clash", async () => {
    await write(api, "/new.txt", "new");
    // /shadow.txt exists in both -> single entry
    const listed = await names(api.list("/"));
    const dupes = listed.filter((n) => n === "shadow.txt");
    expect(dupes.length).toBe(1);
    expect(listed).toEqual(expect.arrayContaining(["keep.txt", "shadow.txt", "dir", "new.txt"]));

    // clash: base dir vs writable file -> writable (file) wins
    await write(base, "/clash/inner.txt", "d");
    await write(api, "/clash", "f");
    const entries: { name: string; kind: string }[] = [];
    for await (const e of api.list("/")) entries.push(e);
    expect(entries.find((e) => e.name === "clash")?.kind).toBe("file");
  });

  it("never mutates the base layer (spy assertion)", async () => {
    const spied = new MemFilesApi();
    await write(spied, "/f.txt", "v");
    const writeSpy = vi.spyOn(spied, "write");
    const removeSpy = vi.spyOn(spied, "remove");
    const moveSpy = vi.spyOn(spied, "move");
    const mkdirSpy = vi.spyOn(spied, "mkdir");
    const copySpy = vi.spyOn(spied, "copy");
    const c = cow(spied, new MemFilesApi());
    await write(c, "/g.txt", "g");
    await c.remove("/f.txt");
    await c.move("/g.txt", "/h.txt");
    await write(c, "/dir/x.txt", "x");
    await c.copy("/f.txt", "/f-copy.txt");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    // and the original data is intact
    expect(await readAll(spied.read("/f.txt"))).toBe("v");
  });

  it("supports a custom whiteout prefix and opaque name", async () => {
    const c = cow(base, writable, { whiteoutPrefix: ".del.", opaqueName: ".del..all" });
    expect(await c.remove("/keep.txt")).toBe(true);
    expect(await c.exists("/keep.txt")).toBe(false);
    for (const n of await names(c.list("/"))) {
      expect(n.startsWith(".del.")).toBe(false);
    }
  });
});
