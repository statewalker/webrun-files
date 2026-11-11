// Appends: `openWrite(path, { append: true })` adds the stream's chunks to the end of the file.
// A FilesApi with an `append(path, content)` method does it itself; any other is appended to with
// read, write and remove only (old content and the chunks into a temporary sibling, then back).
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { type AppendableFilesApi, newFilesRpcClient, newFilesRpcServer } from "../src/index.js";
import { bytes, collect, concat, sleep, text, transport } from "./helpers.js";

const str = async (fs: FilesApi, path: string) =>
  new TextDecoder().decode(await collect(fs.read(path)));
const paths = async (fs: FilesApi) => {
  const out: string[] = [];
  for await (const e of fs.list("/", { recursive: true })) out.push(e.path);
  return out;
};

/** A MemFilesApi with its own append, which records what it was given. */
function appendable(initialFiles: Record<string, string> = {}) {
  const fs = new MemFilesApi({ initialFiles }) as MemFilesApi & AppendableFilesApi;
  const calls: string[] = [];
  fs.append = async (path, content) => {
    calls.push(path);
    const parts: Uint8Array[] = [await collect(fs.read(path))];
    for await (const c of content) parts.push(c);
    await fs.write(path, [concat(parts)]);
  };
  return { fs, calls };
}

describe("append: a FilesApi that appends itself", () => {
  it("gets the stream's chunks in order through its own append", async () => {
    const { fs, calls } = appendable({ "/log.txt": "a" });
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/log.txt", { append: true });
    await Promise.all([
      server.writeChunk(streamId, 1, text("c")),
      server.writeChunk(streamId, 0, text("b")),
    ]);
    await server.closeWrite(streamId, 2);
    expect(await str(fs, "/log.txt")).toBe("abc");
    expect(calls).toEqual(["/log.txt"]);
  });
});

describe("append: any other FilesApi (read, write and remove only)", () => {
  it("adds to the end of an existing file, and leaves nothing else behind", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/d/log.txt": "one\n" } });
    const server = newFilesRpcServer({ fs, chunkSize: 4 });
    const client = newFilesRpcClient({ rpc: server, chunkSize: 3 });
    await client.append("/d/log.txt", [text("two\n"), text("three\n")]);
    expect(await str(fs, "/d/log.txt")).toBe("one\ntwo\nthree\n");
    expect(await paths(fs)).toEqual(["/d", "/d/log.txt"]);
  });

  it("creates a file that does not exist", async () => {
    const fs = new MemFilesApi();
    const client = newFilesRpcClient({ rpc: newFilesRpcServer({ fs }) });
    await client.append("/new.txt", [text("hello")]);
    expect(await str(fs, "/new.txt")).toBe("hello");
    expect(await paths(fs)).toEqual(["/new.txt"]);
  });

  it("keeps the bytes of a large file and of the appended chunks", async () => {
    const old = bytes(300_000, 5);
    const more = bytes(200_000, 6);
    const fs = new MemFilesApi({ initialFiles: { "/big.bin": old } });
    const client = newFilesRpcClient({
      rpc: newFilesRpcServer({ fs, chunkSize: 8192 }),
      chunkSize: 8192,
    });
    await client.append("/big.bin", [more]);
    expect(await collect(fs.read("/big.bin"))).toEqual(concat([old, more]));
  });

  it("an aborted append changes nothing and leaves no temporary file", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/log.txt": "old" } });
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/log.txt", { append: true });
    await server.writeChunk(streamId, 0, text("new"));
    await server.abortWrite(streamId, "no");
    await sleep(10);
    expect(await str(fs, "/log.txt")).toBe("old");
    expect(await paths(fs)).toEqual(["/log.txt"]);
  });

  it("a failing source fails the append: the file keeps what it had", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/log.txt": "old" } });
    const client = newFilesRpcClient({ rpc: newFilesRpcServer({ fs }), chunkSize: 2 });
    async function* broken() {
      yield text("ne");
      throw new Error("source broke");
    }
    await expect(client.append("/log.txt", broken())).rejects.toThrow("source broke");
    await sleep(10);
    expect(await str(fs, "/log.txt")).toBe("old");
    expect(await paths(fs)).toEqual(["/log.txt"]);
  });

  it("appending to a directory fails and changes nothing", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/d/a.txt": "a" } });
    const client = newFilesRpcClient({ rpc: newFilesRpcServer({ fs }) });
    await expect(client.append("/d", [text("x")])).rejects.toMatchObject({ code: "INVALID" });
    expect(await paths(fs)).toEqual(["/d", "/d/a.txt"]);
  });
});

describe("append: what the emulation must not do", () => {
  it("works on a FilesApi that empties a file as soon as a write to it starts", async () => {
    const inner = new MemFilesApi({ initialFiles: { "/log.txt": "kept|" } });
    // Like a file opened with O_TRUNC: the old content is gone before the first chunk is read.
    const truncating: FilesApi = Object.create(inner);
    truncating.write = async (path, content) => {
      await inner.write(path, []);
      await inner.write(path, content);
    };
    const client = newFilesRpcClient({ rpc: newFilesRpcServer({ fs: truncating }) });
    await client.append("/log.txt", [text("added")]);
    expect(await str(inner, "/log.txt")).toBe("kept|added");
    expect(await paths(inner)).toEqual(["/log.txt"]);
  });

  it("an aborted append through the FilesApi's own append appends nothing", async () => {
    const { fs, calls } = appendable({ "/log.txt": "old" });
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/log.txt", { append: true });
    await server.writeChunk(streamId, 0, text("new"));
    await server.abortWrite(streamId);
    await sleep(10);
    expect(calls).toEqual(["/log.txt"]);
    expect(await str(fs, "/log.txt")).toBe("old");
  });
});

describe("append: over a transport", () => {
  it("cloned, reordered and duplicated calls still append each chunk once, in order", async () => {
    for (const seed of [1, 2, 3]) {
      const fs = new MemFilesApi({ initialFiles: { "/log.bin": bytes(1000, 1) } });
      const server = newFilesRpcServer({ fs, chunkSize: 100 });
      const { rpc } = transport(server, { maxDelay: 3, duplicate: 0.3, seed });
      const client = newFilesRpcClient({ rpc, chunkSize: 100, writeAhead: 4 });
      const more = bytes(2500, seed + 10);
      await client.append("/log.bin", [more]);
      expect(await collect(fs.read("/log.bin"))).toEqual(concat([bytes(1000, 1), more]));
      expect(server.openStreams()).toBe(0);
    }
  });

  it("an open delivered twice opens one append stream", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/log.txt": "a" } });
    const server = newFilesRpcServer({ fs });
    const id = "0123456789abcdef0123";
    await Promise.all([
      server.openWrite("/log.txt", { streamId: id, append: true }),
      server.openWrite("/log.txt", { streamId: id, append: true }),
    ]);
    expect(server.openStreams()).toBe(1);
    await server.writeChunk(id, 0, text("b"));
    await server.closeWrite(id, 1);
    expect(await str(fs, "/log.txt")).toBe("ab");
  });
});
