import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { errorCode, FilesRpcError, newFilesRpcClient, newFilesRpcServer } from "../src/index.js";
import { bytes, collect, deferred, sleep, text, transport } from "./helpers.js";

const ID = "0123456789abcdef0123";

describe("protocol: keys chosen by the caller make every call safe to deliver twice", () => {
  it("an open with the same streamId opens one stream", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi({ initialFiles: { "/a": "abc" } }) });
    const [one, two] = await Promise.all([
      server.openRead("/a", { streamId: ID }),
      server.openRead("/a", { streamId: ID }),
    ]);
    expect(one.streamId).toBe(ID);
    expect(two.streamId).toBe(ID);
    expect(server.openStreams()).toBe(1);
  });

  it("an open delivered after its stream ended does not open it again", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi({ initialFiles: { "/a": "abc" } }) });
    await server.openRead("/a", { streamId: ID });
    await server.closeRead(ID);
    await expect(server.openRead("/a", { streamId: ID })).rejects.toMatchObject({
      code: "INVALID",
    });
    expect(server.openStreams()).toBe(0);
  });

  it("a stream id is checked: its form, and its kind", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi() });
    await expect(server.openRead("/a", { streamId: "short" })).rejects.toMatchObject({
      code: "INVALID",
    });
    await expect(
      server.openRead("/a", { streamId: "../../etc/passwd/xxxxxxxx" }),
    ).rejects.toMatchObject({
      code: "INVALID",
    });
    await server.openWrite("/a", { streamId: ID });
    await expect(server.openRead("/a", { streamId: ID })).rejects.toMatchObject({
      code: "INVALID",
    });
    await expect(server.readChunk(ID, 0)).rejects.toMatchObject({ code: "UNKNOWN_STREAM" });
  });

  it("closeWrite delivered again answers as the first did (done, or its failure)", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs });
    await server.openWrite("/a", { streamId: ID });
    await server.writeChunk(ID, 0, text("a"));
    await server.closeWrite(ID, 1);
    await expect(server.closeWrite(ID, 1)).resolves.toBeUndefined();

    const failing = new MemFilesApi();
    failing.write = async (_p, content) => {
      for await (const _ of content) throw new Error("disk full");
    };
    const s2 = newFilesRpcServer({ fs: failing });
    await s2.openWrite("/b", { streamId: ID });
    await s2.writeChunk(ID, 0, text("b")).catch(() => {});
    await expect(s2.closeWrite(ID, 1)).rejects.toThrow("disk full");
    await expect(s2.closeWrite(ID, 1)).rejects.toThrow("disk full");
  });

  it("abortWrite and closeRead of an unknown or ended stream do nothing", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi() });
    await expect(server.abortWrite("nope")).resolves.toBeUndefined();
    await expect(server.closeRead("nope")).resolves.toBeUndefined();
  });
});

describe("protocol: what is refused", () => {
  it("chunk ids are integers from 0; chunks have a size limit; nothing past the count", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi(), maxChunkSize: 10 });
    const { streamId } = await server.openWrite("/a");
    for (const bad of [-1, 1.5, Number.NaN, "x"])
      await expect(server.writeChunk(streamId, bad as number, text("a"))).rejects.toMatchObject({
        code: "INVALID",
      });
    await expect(server.writeChunk(streamId, 0, new Uint8Array(11))).rejects.toMatchObject({
      code: "INVALID",
    });
    await server.writeChunk(streamId, 0, text("a"));
    const close = server.closeWrite(streamId, 2);
    await expect(server.writeChunk(streamId, 2, text("c"))).rejects.toMatchObject({
      code: "INVALID",
    });
    await server.writeChunk(streamId, 1, text("b"));
    await close;
    const r = await server.openRead("/a");
    await expect(server.readChunk(r.streamId, -2)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("a request waiting for a chunk fails when its stream is closed", async () => {
    const fs = new MemFilesApi();
    fs.read = async function* () {
      yield text("a");
      await new Promise(() => {}); // never more
    };
    const server = newFilesRpcServer({ fs, chunkSize: 1 });
    const { streamId } = await server.openRead("/x");
    const waiting = server.readChunk(streamId, 3);
    await sleep(5);
    void server.closeRead(streamId);
    await expect(waiting).rejects.toMatchObject({ code: "UNKNOWN_STREAM" });
  });

  it("errors keep their code across a structured clone (a transport)", async () => {
    const e = new FilesRpcError("CHUNK_RELEASED", "gone");
    const cloned = structuredClone(e);
    expect(cloned).not.toHaveProperty("code");
    expect(errorCode(cloned)).toBe("CHUNK_RELEASED");
    expect(errorCode(new Error("other"))).toBeUndefined();
  });

  it("errorCode reads only protocol codes, not the code of any other error", async () => {
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    expect(errorCode(enoent)).toBeUndefined();
    expect(errorCode({ code: 42 })).toBeUndefined();
    // A code the error carries is read; one it lost is read from the message.
    expect(errorCode(new FilesRpcError("ABORTED", "x"))).toBe("ABORTED");
    expect(errorCode(Object.assign(new Error("INVALID: bad"), { code: "ENOENT" }))).toBe("INVALID");
  });
});

describe("protocol: streams are independent", () => {
  it("many reads and writes at once on one server", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs, chunkSize: 512 });
    const client = newFilesRpcClient({ rpc: server, chunkSize: 512, readAhead: 3, writeAhead: 3 });
    const files = [...Array(20).keys()].map(
      (i) => [`/f/${i}.bin`, bytes(3000 + i * 97, i + 1)] as const,
    );
    await Promise.all(files.map(([p, d]) => client.write(p, [d])));
    const back = await Promise.all(files.map(([p]) => collect(client.read(p))));
    for (const [i, [, d]] of files.entries()) expect(back[i]).toEqual(d);
    expect(server.openStreams()).toBe(0);
  });

  it("a write the server refuses fails the client's write, which aborts it", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs, maxChunkSize: 100 });
    const client = newFilesRpcClient({ rpc: server, chunkSize: 1000 });
    await expect(client.write("/a", [bytes(5000)])).rejects.toMatchObject({ code: "INVALID" });
    await sleep(5);
    expect(server.openStreams()).toBe(0);
    expect(await fs.exists("/a")).toBe(false);
  });
});

describe("protocol: release never drops a chunk nobody has received", () => {
  it("a client asking further ahead than the server retains, out of order, still gets every chunk", async () => {
    const data = bytes(64 * 512, 9);
    const fs = new MemFilesApi({ initialFiles: { "/a.bin": data } });
    const server = newFilesRpcServer({ fs, chunkSize: 512, retain: 3, readAhead: 2 });
    const { streamId } = await server.openRead("/a.bin");
    // Chunk 19 is asked before chunks 0..18 (an out-of-order transport, a deep pipeline).
    const late = server.readChunk(streamId, 19);
    const early = await Promise.all(
      [...Array(19).keys()].map((k) => server.readChunk(streamId, k)),
    );
    expect(early.map((r) => r.data.length)).toEqual(Array(19).fill(512));
    expect((await late).data).toEqual(data.subarray(19 * 512, 20 * 512));
  });

  it("chunks received and left behind are released (memory stays bounded)", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/a.bin": bytes(200 * 100) } });
    const server = newFilesRpcServer({ fs, chunkSize: 100, retain: 4, readAhead: 2 });
    const { streamId } = await server.openRead("/a.bin");
    for (let k = 0; k < 150; k++) await server.readChunk(streamId, k);
    await expect(server.readChunk(streamId, 140)).rejects.toMatchObject({ code: "CHUNK_RELEASED" });
    await expect(server.readChunk(streamId, 147)).resolves.toBeTruthy();
  });
});

describe("protocol: metadata calls delivered twice", () => {
  it("end in the same state; at least one reports the change (the other may not)", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/d/a": "a", "/b": "b" } });
    const server = newFilesRpcServer({ fs });
    const [r1, r2] = await Promise.all([server.remove("/d"), server.remove("/d")]);
    expect(r1 || r2).toBe(true);
    expect(await fs.exists("/d")).toBe(false);
    await Promise.all([server.mkdir("/x/y"), server.mkdir("/x/y")]);
    expect(await fs.stats("/x/y")).toEqual({ kind: "directory" });
    const [m1, m2] = await Promise.all([server.move("/b", "/x/b"), server.move("/b", "/x/b")]);
    expect(m1 || m2).toBe(true);
    expect(new TextDecoder().decode(await collect(fs.read("/x/b")))).toBe("b");
    const [c1, c2] = await Promise.all([server.copy("/x/b", "/c"), server.copy("/x/b", "/c")]);
    expect(c1 || c2).toBe(true);
    expect(new TextDecoder().decode(await collect(fs.read("/c")))).toBe("b");
  });

  it("a retry after the first finished answers for the state it finds", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/a": "a", "/b": "b" } });
    const server = newFilesRpcServer({ fs });
    expect(await server.remove("/a")).toBe(true);
    expect(await server.remove("/a")).toBe(false);
    expect(await server.move("/b", "/m")).toBe(true);
    expect(await server.move("/b", "/m")).toBe(false);
    expect(new TextDecoder().decode(await collect(fs.read("/m")))).toBe("b");
  });
});

describe("protocol: metadata calls with a requestId answer once", () => {
  const RID = "req-0123456789abcdef";

  it("remove, move and copy delivered twice with one requestId run once and answer the same", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/d/a": "a", "/b": "b", "/c": "c" } });
    const server = newFilesRpcServer({ fs });
    // Concurrently (a duplicate in flight) and after the first finished (a late retry).
    const r = await Promise.all([
      server.remove("/d", { requestId: `${RID}-1` }),
      server.remove("/d", { requestId: `${RID}-1` }),
    ]);
    expect(r).toEqual([true, true]);
    expect(await server.remove("/d", { requestId: `${RID}-1` })).toBe(true);
    expect(await server.move("/b", "/m", { requestId: `${RID}-2` })).toBe(true);
    expect(await server.move("/b", "/m", { requestId: `${RID}-2` })).toBe(true);
    expect(await server.copy("/c", "/k", { requestId: `${RID}-3` })).toBe(true);
    await fs.write("/k", [text("changed")]);
    // A late copy retry does not copy again over what was written since.
    expect(await server.copy("/c", "/k", { requestId: `${RID}-3` })).toBe(true);
    expect(new TextDecoder().decode(await collect(fs.read("/k")))).toBe("changed");
    // A new requestId is a new call.
    expect(await server.remove("/d", { requestId: `${RID}-4` })).toBe(false);
  });

  it("a failed call answers its failure again", async () => {
    const fs = new MemFilesApi();
    let calls = 0;
    fs.remove = async () => {
      calls++;
      throw new Error("disk on fire");
    };
    const server = newFilesRpcServer({ fs });
    await expect(server.remove("/x", { requestId: RID })).rejects.toThrow("disk on fire");
    await expect(server.remove("/x", { requestId: RID })).rejects.toThrow("disk on fire");
    expect(calls).toBe(1);
  });

  it("answers are kept for idleTimeout and at most maxRequests of them", async () => {
    let now = 0;
    const fs = new MemFilesApi({ initialFiles: { "/a": "a" } });
    const server = newFilesRpcServer({ fs, idleTimeout: 1000, maxRequests: 2, now: () => now });
    expect(await server.remove("/a", { requestId: `${RID}-a` })).toBe(true);
    now += 2000;
    server.sweep();
    expect(await server.remove("/a", { requestId: `${RID}-a` })).toBe(false); // forgotten: runs again
    await server.mkdir("/x", { requestId: `${RID}-x` });
    await server.mkdir("/y", { requestId: `${RID}-y` });
    await server.mkdir("/z", { requestId: `${RID}-z` }); // the oldest answer goes
    await fs.remove("/x");
    await server.mkdir("/x", { requestId: `${RID}-x` });
    expect(await fs.exists("/x")).toBe(true);
  });

  it("a call still running after idleTimeout keeps its requestId: a retry does not run it again", async () => {
    let now = 0;
    const fs = new MemFilesApi({ initialFiles: { "/a": "a" } });
    const slow = deferred();
    let calls = 0;
    const copy = fs.copy.bind(fs);
    fs.copy = async (source, target) => {
      calls++;
      await slow.promise;
      return copy(source, target);
    };
    const server = newFilesRpcServer({ fs, idleTimeout: 1000, now: () => now });
    const first = server.copy("/a", "/b", { requestId: RID });
    await sleep(1);
    // The copy takes longer than idleTimeout; the transport retries it meanwhile.
    now += 5000;
    server.sweep();
    const retry = server.copy("/a", "/b", { requestId: RID });
    slow.resolve();
    expect(await first).toBe(true);
    expect(await retry).toBe(true);
    expect(calls).toBe(1);
    // Once settled, the answer is kept for idleTimeout from then, and forgotten after.
    now += 500;
    server.sweep();
    expect(await server.copy("/a", "/b", { requestId: RID })).toBe(true);
    expect(calls).toBe(1);
    now += 2000;
    server.sweep();
    await server.copy("/a", "/b", { requestId: RID });
    expect(calls).toBe(2);
  });

  it("past maxRequests a settled answer goes first, not that of a call still running", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/a": "a" } });
    const slow = deferred();
    let calls = 0;
    const copy = fs.copy.bind(fs);
    fs.copy = async (source, target) => {
      calls++;
      await slow.promise;
      return copy(source, target);
    };
    const server = newFilesRpcServer({ fs, maxRequests: 2 });
    const first = server.copy("/a", "/b", { requestId: `${RID}-c` });
    await server.mkdir("/x", { requestId: `${RID}-x` });
    await server.mkdir("/y", { requestId: `${RID}-y` });
    const retry = server.copy("/a", "/b", { requestId: `${RID}-c` });
    slow.resolve();
    expect(await first).toBe(true);
    expect(await retry).toBe(true);
    expect(calls).toBe(1);
  });

  it("past maxRequests with every call running, the oldest goes (the cap holds)", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/a": "a" } });
    const slow = deferred();
    let calls = 0;
    const copy = fs.copy.bind(fs);
    fs.copy = async (source, target) => {
      calls++;
      await slow.promise;
      return copy(source, target);
    };
    const server = newFilesRpcServer({ fs, maxRequests: 2 });
    const running = [1, 2, 3].map((i) => server.copy("/a", `/b${i}`, { requestId: `${RID}-${i}` }));
    // The first was forgotten: a retry of it runs again; the last two are still known.
    running.push(server.copy("/a", "/b1", { requestId: `${RID}-1` }));
    running.push(server.copy("/a", "/b3", { requestId: `${RID}-3` }));
    slow.resolve();
    await Promise.all(running);
    expect(calls).toBe(4);
  });

  it("a requestId is checked like a stream id", async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi() });
    await expect(server.remove("/a", { requestId: "short" })).rejects.toMatchObject({
      code: "INVALID",
    });
  });

  it("the client gives every remove, move, copy and mkdir a requestId", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/d/a": "a" } });
    const server = newFilesRpcServer({ fs });
    const seen: unknown[] = [];
    const rpc = new Proxy(server, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (["remove", "move", "copy", "mkdir"].includes(String(key))) seen.push(args.at(-1));
          return v.apply(target, args);
        };
      },
    });
    const client = newFilesRpcClient({ rpc });
    await client.mkdir("/e");
    await client.copy("/d/a", "/e/a");
    await client.move("/e/a", "/e/b");
    await client.remove("/d");
    expect(seen).toHaveLength(4);
    for (const o of seen)
      expect((o as { requestId?: string }).requestId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it("duplicated delivery of every call now keeps the conformance answers (remove reports true once done)", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/d/a": "a" } });
    const server = newFilesRpcServer({ fs });
    const { rpc } = transport(server, { duplicate: 1, maxDelay: 2 });
    const client = newFilesRpcClient({ rpc });
    expect(await client.remove("/d")).toBe(true);
    expect(await client.copy("/none", "/x")).toBe(false);
  });
});
