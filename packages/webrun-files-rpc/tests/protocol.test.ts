import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { errorCode, FilesRpcError, newFilesRpcClient, newFilesRpcServer } from "../src/index.js";
import { bytes, collect, sleep, text } from "./helpers.js";

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
  });
});
