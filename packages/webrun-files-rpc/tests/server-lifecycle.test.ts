import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newFilesRpcServer } from "../src/index.js";
import { bytes, collect, countingFs, text } from "./helpers.js";

describe("server: stream lifecycle", () => {
  it("drops streams idle longer than idleTimeout (a reader's source ends, a writer is aborted)", async () => {
    let now = 1_000;
    const { fs, stats } = countingFs(
      new MemFilesApi({ initialFiles: { "/a.bin": bytes(5000), "/b.txt": "old" } }),
      100,
    );
    const server = newFilesRpcServer({ fs, chunkSize: 100, idleTimeout: 60_000, now: () => now });
    const r = await server.openRead("/a.bin");
    await server.readChunk(r.streamId, 0);
    const w = await server.openWrite("/b.txt");
    await server.writeChunk(w.streamId, 0, text("new"));
    await new Promise((r) => setTimeout(r, 5)); // the file system takes it (idle from then on)
    now += 30_000;
    expect(server.sweep()).toBe(0);
    await server.readChunk(r.streamId, 1); // used: idle time starts again
    now += 45_000;
    expect(server.sweep()).toBe(1); // the writer
    now += 30_000;
    expect(server.sweep()).toBe(1); // the reader
    expect(server.openStreams()).toBe(0);
    await new Promise((r) => setTimeout(r, 5)); // the source ends asynchronously
    expect(stats.returned).toBe(1);
    await expect(server.readChunk(r.streamId, 2)).rejects.toMatchObject({ code: "UNKNOWN_STREAM" });
    expect(new TextDecoder().decode(await collect(fs.read("/b.txt")))).toBe("old");
  });

  it("opening sweeps first, then refuses past maxStreams", async () => {
    let now = 0;
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a": "a" } }),
      maxStreams: 2,
      idleTimeout: 1000,
      now: () => now,
    });
    await server.openRead("/a");
    await server.openWrite("/b");
    await expect(server.openRead("/a")).rejects.toMatchObject({ code: "TOO_MANY_STREAMS" });
    now += 2000;
    await expect(server.openRead("/a")).resolves.toHaveProperty("streamId");
  });

  it("close() ends every stream", async () => {
    const { fs, stats } = countingFs(new MemFilesApi({ initialFiles: { "/a": bytes(1000) } }), 10);
    const server = newFilesRpcServer({ fs, chunkSize: 10 });
    const r = await server.openRead("/a");
    await server.readChunk(r.streamId, 0);
    const w = await server.openWrite("/b");
    await server.close();
    expect(server.openStreams()).toBe(0);
    expect(stats.returned).toBe(1);
    await expect(server.writeChunk(w.streamId, 0, text("x"))).rejects.toMatchObject({
      code: "UNKNOWN_STREAM",
    });
    expect(await fs.exists("/b")).toBe(false);
  });

  it("stream ids are unguessable and distinct", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi({ initialFiles: { "/a": "a" } }) });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { streamId } = await server.openRead("/a");
      ids.add(streamId);
      await server.closeRead(streamId);
    }
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(16);
  });
});

describe("server: metadata", () => {
  const fs = () =>
    new MemFilesApi({
      initialFiles: { "/d/a.txt": "a", "/d/b.txt": "bb", "/d/e/c.txt": "ccc", "/z.txt": "z" },
    });

  it("lists in pages (path order, after, recursive) up to maxPageSize", async () => {
    const server = newFilesRpcServer({ fs: fs(), maxPageSize: 2 });
    const first = await server.list("/", { recursive: true, limit: 100 });
    expect(first.entries.map((e) => e.path)).toEqual(["/d", "/d/a.txt"]);
    expect(first.more).toBe(true);
    const all: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await server.list("/", { recursive: true, after, limit: 2 });
      all.push(...page.entries.map((e) => e.path));
      if (!page.more) break;
      after = page.entries.at(-1)?.path;
    }
    expect(all).toEqual(["/d", "/d/a.txt", "/d/b.txt", "/d/e", "/d/e/c.txt", "/z.txt"]);
    const top = await newFilesRpcServer({ fs: fs() }).list("/d");
    expect(top.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "e"]);
    expect(top.more).toBe(false);
    // A limit above maxPageSize is cut to it.
    expect((await server.list("/d", { limit: 100 })).entries.length).toBe(2);
  });

  it("answers stats, exists, mkdir, remove, move and copy as the FilesApi does", async () => {
    const files = fs();
    const server = newFilesRpcServer({ fs: files });
    expect(await server.stats("/d/b.txt")).toMatchObject({ kind: "file", size: 2 });
    expect(await server.stats("/d")).toEqual({ kind: "directory" });
    expect(await server.stats("/none")).toBeUndefined();
    expect(await server.exists("/d/a.txt")).toBe(true);
    await server.mkdir("/x/y");
    expect(await files.exists("/x/y")).toBe(true);
    expect(await server.copy("/d/a.txt", "/x/a.txt")).toBe(true);
    expect(await server.move("/x/a.txt", "/x/y/a.txt")).toBe(true);
    expect(await server.remove("/d")).toBe(true);
    expect(await server.remove("/d")).toBe(false);
    expect(await files.exists("/x/y/a.txt")).toBe(true);
  });
});
