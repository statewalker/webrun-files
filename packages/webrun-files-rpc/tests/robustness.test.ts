// Bounds, expiry, error reporting and cleanup under misbehaving callers, slow file systems and
// failing sources.
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newFilesRpcClient, newFilesRpcServer } from "../src/index.js";
import { bytes, collect, countingFs, deferred, sleep, text } from "./helpers.js";

describe("robustness: a request cannot make the server do unbounded work", () => {
  it("a chunk id far past the lowest undelivered one is refused at once", async () => {
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a": bytes(1000) } }),
      chunkSize: 10,
      window: 8,
    });
    const { streamId } = await server.openRead("/a");
    const started = Date.now();
    await expect(server.readChunk(streamId, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
      code: "INVALID",
    });
    await expect(server.readChunk(streamId, 2e8)).rejects.toMatchObject({ code: "INVALID" });
    expect(Date.now() - started).toBeLessThan(100);
    // Within the window it is served.
    await expect(server.readChunk(streamId, 7)).resolves.toMatchObject({ done: false });
  });

  it("what is pulled from the source stays within window + readAhead chunks", async () => {
    const { fs, stats } = countingFs(
      new MemFilesApi({ initialFiles: { "/a": bytes(100_000) } }),
      100,
    );
    const server = newFilesRpcServer({ fs, chunkSize: 100, window: 16, readAhead: 2 });
    const { streamId } = await server.openRead("/a");
    await server.readChunk(streamId, 15);
    await sleep(20);
    expect(stats.pulled).toBeLessThanOrEqual(15 + 2 + 1);
    await expect(server.readChunk(streamId, 900)).rejects.toMatchObject({ code: "INVALID" });
    // Delivering the lowest chunks moves the window.
    for (let k = 0; k < 16; k++) await server.readChunk(streamId, k);
    await expect(server.readChunk(streamId, 30)).resolves.toBeTruthy();
  });
});

describe("robustness: calls in progress keep a stream alive", () => {
  it("a closeWrite waiting on a slow commit is not swept, nor a readChunk on a slow source", async () => {
    let now = 0;
    const gate = deferred();
    const fs = new MemFilesApi({ initialFiles: { "/r": "abc" } });
    const write = fs.write.bind(fs);
    fs.write = async (path, content) => {
      const parts: Uint8Array[] = [];
      for await (const c of content) parts.push(c);
      await gate.promise; // a slow commit
      return write(path, parts);
    };
    const read = fs.read.bind(fs);
    const slowSource = deferred();
    fs.read = async function* (p, o) {
      await slowSource.promise;
      yield* read(p, o);
    };
    const server = newFilesRpcServer({ fs, idleTimeout: 1000, now: () => now });
    const w = await server.openWrite("/w");
    await server.writeChunk(w.streamId, 0, text("x"));
    const closing = server.closeWrite(w.streamId, 1);
    const r = await server.openRead("/r");
    const reading = server.readChunk(r.streamId, 0);
    now += 5000;
    expect(server.sweep()).toBe(0);
    gate.resolve();
    slowSource.resolve();
    await expect(closing).resolves.toBeUndefined();
    await expect(reading).resolves.toMatchObject({ done: true });
    expect(new TextDecoder().decode(await collect(fs.read("/w")))).toBe("x");
  });

  it("sweepInterval sweeps on a timer, without any open", async () => {
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a": "a" } }),
      idleTimeout: 20,
      sweepInterval: 10,
    });
    await server.openRead("/a");
    await sleep(80);
    expect(server.openStreams()).toBe(0);
    await server.close();
  });
});

describe("robustness: errors reach the caller as they were", () => {
  it("a write the FilesApi fails at once: the client sees that failure, not UNKNOWN_STREAM", async () => {
    const fs = new MemFilesApi();
    fs.write = async () => {
      throw new Error("disk full");
    };
    const server = newFilesRpcServer({ fs, chunkSize: 10 });
    const client = newFilesRpcClient({ rpc: server, chunkSize: 10, writeAhead: 1 });
    await expect(client.write("/a", [bytes(100)])).rejects.toThrow("disk full");
  });

  it("an abort after every chunk was written does not turn the commit into a failure", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/a");
    await server.writeChunk(streamId, 0, text("a"));
    const closing = server.closeWrite(streamId, 1);
    await server.abortWrite(streamId, "the client lost closeWrite's answer");
    await expect(closing).resolves.toBeUndefined();
    expect(new TextDecoder().decode(await collect(fs.read("/a")))).toBe("a");
  });

  it("a source yielding something that is not bytes fails the stream (no unhandled rejection)", async () => {
    const fs = new MemFilesApi();
    fs.read = async function* () {
      yield "not bytes" as unknown as Uint8Array;
    };
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openRead("/x");
    await expect(server.readChunk(streamId, 0)).rejects.toMatchObject({ code: "INVALID" });
    await expect(server.readChunk(streamId, 1)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("a writeChunk waiting for room past the count is refused when the stream closes", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs, writeWindow: 1 });
    const { streamId } = await server.openWrite("/a");
    const stray = server.writeChunk(streamId, 5, text("x"));
    await server.writeChunk(streamId, 0, text("a"));
    await server.closeWrite(streamId, 1);
    await expect(stray).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("robustness: nothing waits forever", () => {
  it("aborting a read interrupts a chunk request that does not answer", async () => {
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a": bytes(100) } }),
      chunkSize: 10,
    });
    let closed = false;
    const rpc = new Proxy(server, {
      get(target, method: string) {
        // biome-ignore lint/suspicious/noExplicitAny: a hanging wrapper
        const fn = (target as any)[method].bind(target);
        if (method === "closeRead")
          return (...a: unknown[]) => {
            closed = true;
            return fn(...a);
          };
        if (method !== "readChunk") return fn;
        return (id: string, k: number) => (k === 0 ? fn(id, k) : new Promise(() => {}));
      },
    });
    const client = newFilesRpcClient({ rpc, chunkSize: 10 });
    const ac = new AbortController();
    const it = client.read("/a", { signal: ac.signal })[Symbol.asyncIterator]();
    await it.next();
    const next = it.next();
    await sleep(10);
    ac.abort();
    const settled = await Promise.race([
      next.then(
        () => "resolved",
        () => "rejected",
      ),
      sleep(100).then(() => "pending"),
    ]);
    expect(settled).toBe("rejected");
    expect(closed).toBe(true);
  });

  it("close() does not wait for a write the FilesApi never finishes", async () => {
    const fs = new MemFilesApi();
    fs.write = () => new Promise(() => {});
    const server = newFilesRpcServer({ fs });
    await server.openWrite("/a");
    const result = await Promise.race([
      server.close().then(() => "closed"),
      sleep(100).then(() => "hung"),
    ]);
    expect(result).toBe("closed");
  });
});

describe("robustness: listing does not trust the FilesApi with `after`", () => {
  it("pages end even if list() ignores `after`", async () => {
    const files = new MemFilesApi({
      initialFiles: { "/a": "1", "/b": "2", "/c": "3", "/d": "4", "/e": "5" },
    });
    const ignoringAfter: FilesApi = Object.create(files);
    ignoringAfter.list = (path, options) => files.list(path, { ...options, after: undefined });
    const server = newFilesRpcServer({ fs: ignoringAfter, maxPageSize: 2 });
    const client = newFilesRpcClient({ rpc: server, pageSize: 2 });
    const seen: string[] = [];
    for await (const e of client.list("/") as AsyncIterable<FileInfo>) {
      seen.push(e.path);
      if (seen.length > 10) break;
    }
    expect(seen).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });
});

describe("robustness: a writer cannot pin memory or a stream", () => {
  it("a chunk more than two windows past the next to write is refused", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi(), writeWindow: 2 });
    const { streamId } = await server.openWrite("/a");
    await expect(server.writeChunk(streamId, 4, text("x"))).rejects.toMatchObject({
      code: "INVALID",
    });
    await expect(server.writeChunk(streamId, 100, text("x"))).rejects.toMatchObject({
      code: "INVALID",
    });
    // Within two windows: kept (0, 1) or waiting for room (2, 3).
    const waiting = [
      server.writeChunk(streamId, 2, text("c")),
      server.writeChunk(streamId, 3, text("d")),
    ];
    await server.writeChunk(streamId, 1, text("b"));
    await server.writeChunk(streamId, 0, text("a"));
    await Promise.all(waiting);
    await server.closeWrite(streamId, 4);
  });

  it("a write waiting for the holder's chunks is swept once idle, waiters and all", async () => {
    let now = 0;
    const fs = new MemFilesApi({ initialFiles: { "/a": "old" } });
    const server = newFilesRpcServer({ fs, writeWindow: 1, idleTimeout: 1000, now: () => now });
    const { streamId } = await server.openWrite("/a");
    const far = server.writeChunk(streamId, 1, text("b")); // waits for chunk 0, which never comes
    const close = server.closeWrite(streamId, 2);
    far.catch(() => {});
    close.catch(() => {});
    now += 5000;
    expect(server.sweep()).toBe(1);
    await expect(far).rejects.toMatchObject({ code: "ABORTED" });
    await expect(close).rejects.toMatchObject({ code: "ABORTED" });
    expect(server.openStreams()).toBe(0);
    expect(new TextDecoder().decode(await collect(fs.read("/a")))).toBe("old");
  });
});
