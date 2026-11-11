import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newFilesRpcClient, newFilesRpcServer } from "../src/index.js";
import { bytes, collect, deferred, text, transport } from "./helpers.js";

const KB = 1024;

function pair(options: { chunkSize?: number; readAhead?: number; writeAhead?: number } = {}) {
  const fs = new MemFilesApi();
  const server = newFilesRpcServer({ fs, chunkSize: options.chunkSize ?? KB });
  const { rpc, calls } = transport(server);
  const client: FilesApi = newFilesRpcClient({
    rpc,
    chunkSize: options.chunkSize ?? KB,
    readAhead: options.readAhead,
    writeAhead: options.writeAhead,
  });
  return { fs, server, client, calls };
}

describe("client: a FilesApi over the RPC", () => {
  it("writes and reads back content of any size, in chunks of chunkSize", async () => {
    const { fs, client, calls } = pair({ chunkSize: 4 * KB });
    const data = bytes(100 * KB + 3);
    // Odd input pieces: the client cuts chunks itself.
    await client.write("/a/big.bin", [
      data.subarray(0, 7),
      data.subarray(7, 50_000),
      data.subarray(50_000),
    ]);
    expect(await collect(fs.read("/a/big.bin"))).toEqual(data);
    const writes = calls.filter((c) => c.method === "writeChunk");
    expect(writes.length).toBe(Math.ceil(data.length / (4 * KB)));
    for (const w of writes) expect((w.args[2] as Uint8Array).length).toBeLessThanOrEqual(4 * KB);
    expect(await collect(client.read("/a/big.bin"))).toEqual(data);
  });

  it("accepts sync and async iterables, and an empty one", async () => {
    const { client } = pair();
    async function* gen() {
      yield text("he");
      yield text("llo");
    }
    await client.write("/g.txt", gen());
    expect(new TextDecoder().decode(await collect(client.read("/g.txt")))).toBe("hello");
    await client.write("/e.txt", []);
    expect(await client.stats("/e.txt")).toMatchObject({ kind: "file", size: 0 });
  });

  it("reads ranges, and a missing file as nothing", async () => {
    const { client } = pair();
    const data = bytes(10 * KB);
    await client.write("/a.bin", [data]);
    expect(await collect(client.read("/a.bin", { start: 3000, length: 4000 }))).toEqual(
      data.subarray(3000, 7000),
    );
    expect(await collect(client.read("/a.bin", { start: 9000 }))).toEqual(data.subarray(9000));
    expect((await collect(client.read("/missing"))).length).toBe(0);
    expect((await collect(client.read("/a.bin", { length: 0 }))).length).toBe(0);
  });

  it("keeps readAhead chunk requests in flight and yields them in order", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/a.bin": bytes(20 * KB) } });
    const server = newFilesRpcServer({ fs, chunkSize: KB, readAhead: 8 });
    let inFlight = 0;
    let most = 0;
    const rpc = new Proxy(server, {
      get(target, method: string) {
        // biome-ignore lint/suspicious/noExplicitAny: a counting wrapper
        const fn = (target as any)[method].bind(target);
        if (method !== "readChunk") return fn;
        return async (...args: unknown[]) => {
          inFlight++;
          most = Math.max(most, inFlight);
          try {
            await new Promise((r) => setTimeout(r, 2));
            return await fn(...args);
          } finally {
            inFlight--;
          }
        };
      },
    });
    const client = newFilesRpcClient({ rpc, chunkSize: KB, readAhead: 4 });
    expect(await collect(client.read("/a.bin"))).toEqual(await collect(fs.read("/a.bin")));
    expect(most).toBe(4);
  });

  it("stopping a read early, or aborting it, closes the stream", async () => {
    const { client, server } = pair();
    await client.write("/a.bin", [bytes(20 * KB)]);
    for await (const _ of client.read("/a.bin")) break;
    expect(server.openStreams()).toBe(0);
    const ac = new AbortController();
    const it = client.read("/a.bin", { signal: ac.signal })[Symbol.asyncIterator]();
    await it.next();
    ac.abort();
    await expect(it.next()).rejects.toThrow();
    expect(server.openStreams()).toBe(0);
  });

  it("a failing source aborts the write: the file keeps what it had", async () => {
    const { client, fs, calls, server } = pair();
    await client.write("/a.txt", [text("old")]);
    async function* failing() {
      yield text("new");
      throw new Error("source broke");
    }
    await expect(client.write("/a.txt", failing())).rejects.toThrow("source broke");
    expect(calls.some((c) => c.method === "abortWrite")).toBe(true);
    expect(new TextDecoder().decode(await collect(fs.read("/a.txt")))).toBe("old");
    expect(server.openStreams()).toBe(0);
  });

  it("keeps at most writeAhead chunks unacknowledged", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs, chunkSize: KB });
    const gate = deferred();
    let inFlight = 0;
    let most = 0;
    const rpc = new Proxy(server, {
      get(target, method: string) {
        // biome-ignore lint/suspicious/noExplicitAny: a counting wrapper
        const fn = (target as any)[method].bind(target);
        if (method !== "writeChunk") return fn;
        return async (...args: unknown[]) => {
          inFlight++;
          most = Math.max(most, inFlight);
          await gate.promise;
          try {
            return await fn(...args);
          } finally {
            inFlight--;
          }
        };
      },
    });
    const client = newFilesRpcClient({ rpc, chunkSize: KB, writeAhead: 3 });
    const done = client.write("/a.bin", [bytes(10 * KB)]);
    await new Promise((r) => setTimeout(r, 10));
    expect(most).toBe(3);
    gate.resolve();
    await done;
    expect((await fs.stats("/a.bin")) as { size: number }).toMatchObject({ size: 10 * KB });
  });

  it("lists across pages and does the rest of the FilesApi", async () => {
    const fs = new MemFilesApi({
      initialFiles: { "/d/a": "1", "/d/b": "22", "/d/e/c": "333", "/z": "4" },
    });
    const server = newFilesRpcServer({ fs, maxPageSize: 2 });
    const client = newFilesRpcClient({ rpc: transport(server).rpc, pageSize: 2 });
    const paths: string[] = [];
    for await (const e of client.list("/", { recursive: true })) paths.push(e.path);
    expect(paths).toEqual(["/d", "/d/a", "/d/b", "/d/e", "/d/e/c", "/z"]);
    const after: string[] = [];
    for await (const e of client.list("/", { recursive: true, after: "/d/b" })) after.push(e.path);
    expect(after).toEqual(["/d/e", "/d/e/c", "/z"]);
    const top: string[] = [];
    for await (const e of client.list("/d")) top.push(e.name);
    expect(top).toEqual(["a", "b", "e"]);
    expect(await client.stats("/d/b")).toMatchObject({ kind: "file", size: 2 });
    expect(await client.exists("/nope")).toBe(false);
    await client.mkdir("/m/n");
    expect(await client.copy("/d/a", "/m/a")).toBe(true);
    expect(await client.move("/m/a", "/m/n/a")).toBe(true);
    expect(await client.remove("/d")).toBe(true);
    expect(await fs.exists("/m/n/a")).toBe(true);
    expect(await fs.exists("/d/a")).toBe(false);
  });
});

describe("client and server over an unreliable transport", () => {
  it("delayed, reordered and duplicated calls still move every byte, in order", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const fs = new MemFilesApi();
      const server = newFilesRpcServer({ fs, chunkSize: KB, readAhead: 6, writeWindow: 8 });
      const { rpc } = transport(server, { maxDelay: 4, duplicate: 0.3, seed });
      const client = newFilesRpcClient({ rpc, chunkSize: KB, readAhead: 6, writeAhead: 6 });
      const data = bytes(40 * KB + seed, seed);
      await client.write(`/f${seed}.bin`, [data]);
      expect(await collect(fs.read(`/f${seed}.bin`))).toEqual(data);
      expect(await collect(client.read(`/f${seed}.bin`))).toEqual(data);
      expect(await collect(client.read(`/f${seed}.bin`, { start: 5000, length: 9000 }))).toEqual(
        data.subarray(5000, 14000),
      );
      await new Promise((r) => setTimeout(r, 20)); // late duplicates land
      expect(server.openStreams()).toBe(0);
    }
  });
});
