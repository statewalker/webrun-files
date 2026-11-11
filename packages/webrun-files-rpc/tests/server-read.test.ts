import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { FilesRpcError, newFilesRpcServer } from "../src/index.js";
import { bytes, concat, countingFs, sleep } from "./helpers.js";

const KB = 1024;

async function readAll(
  server: ReturnType<typeof newFilesRpcServer>,
  streamId: string,
): Promise<{ data: Uint8Array; chunks: number }> {
  const parts: Uint8Array[] = [];
  for (let chunkId = 0; ; chunkId++) {
    const { data, done } = await server.readChunk(streamId, chunkId);
    if (data.length) parts.push(data);
    if (done) return { data: concat(parts), chunks: chunkId + 1 };
  }
}

describe("server: reading by (streamId, chunkId)", () => {
  it("serves a file as numbered chunks of at most chunkSize; the last says done", async () => {
    const data = bytes(10 * KB + 5);
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a.bin": data } }),
      chunkSize: KB,
    });
    const { streamId } = await server.openRead("/a.bin");
    expect(typeof streamId).toBe("string");
    const first = await server.readChunk(streamId, 0);
    expect(first.data.length).toBe(KB);
    expect(first.done).toBe(false);
    const rest = await readAll(server, streamId);
    expect(rest.data).toEqual(data);
    expect(rest.chunks).toBe(11);
    await server.closeRead(streamId);
  });

  it("answers chunks requested out of order and concurrently, each when it exists", async () => {
    const data = bytes(8 * KB);
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a.bin": data } }),
      chunkSize: KB,
      readAhead: 8,
    });
    const { streamId } = await server.openRead("/a.bin");
    const ids = [3, 0, 7, 1, 6, 2, 5, 4];
    const got = await Promise.all(ids.map((id) => server.readChunk(streamId, id)));
    const byId = new Map(ids.map((id, i) => [id, got[i]?.data as Uint8Array]));
    expect(concat([...Array(8).keys()].map((i) => byId.get(i) as Uint8Array))).toEqual(data);
    expect(got[ids.indexOf(7)]?.done).toBe(true);
  });

  it("reads a range (start, length) and a file that does not exist as nothing", async () => {
    const data = bytes(5 * KB);
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a.bin": data } }),
      chunkSize: KB,
    });
    const range = await server.openRead("/a.bin", { start: 1500, length: 2000 });
    expect((await readAll(server, range.streamId)).data).toEqual(data.subarray(1500, 3500));
    const none = await server.openRead("/missing");
    expect(await server.readChunk(none.streamId, 0)).toEqual({
      data: new Uint8Array(),
      done: true,
    });
    const empty = await server.openRead("/a.bin", { length: 0 });
    expect((await server.readChunk(empty.streamId, 0)).done).toBe(true);
  });

  it("chunks past the end are empty and done; the same chunk can be asked again (a retry)", async () => {
    const data = bytes(3 * KB);
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a.bin": data } }),
      chunkSize: KB,
    });
    const { streamId } = await server.openRead("/a.bin");
    const once = await server.readChunk(streamId, 1);
    const again = await server.readChunk(streamId, 1);
    expect(again.data).toEqual(once.data);
    expect(await server.readChunk(streamId, 9)).toEqual({ data: new Uint8Array(), done: true });
  });

  it("keeps a chunk until the reader has moved `retain` chunks past it, then releases it", async () => {
    const server = newFilesRpcServer({
      fs: new MemFilesApi({ initialFiles: { "/a.bin": bytes(20 * KB) } }),
      chunkSize: KB,
      readAhead: 2,
      retain: 3,
    });
    const { streamId } = await server.openRead("/a.bin");
    for (let i = 0; i <= 6; i++) await server.readChunk(streamId, i);
    await expect(server.readChunk(streamId, 4)).resolves.toBeTruthy(); // 6 - 4 < 3: kept
    await expect(server.readChunk(streamId, 2)).rejects.toMatchObject({
      code: "CHUNK_RELEASED",
    });
  });

  it("pulls the source at most readAhead chunks beyond what was asked", async () => {
    const { fs, stats } = countingFs(
      new MemFilesApi({ initialFiles: { "/a.bin": bytes(50 * KB) } }),
      KB,
    );
    const server = newFilesRpcServer({ fs, chunkSize: KB, readAhead: 3 });
    const { streamId } = await server.openRead("/a.bin");
    await server.readChunk(streamId, 0);
    await sleep(20);
    expect(stats.pulled).toBeLessThanOrEqual(1 + 3);
    await server.readChunk(streamId, 10);
    await sleep(20);
    expect(stats.pulled).toBeLessThanOrEqual(11 + 3);
  });

  it("closing a stream ends the source; an unknown stream is an error", async () => {
    const { fs, stats } = countingFs(
      new MemFilesApi({ initialFiles: { "/a.bin": bytes(10 * KB) } }),
      KB,
    );
    const server = newFilesRpcServer({ fs, chunkSize: KB });
    const { streamId } = await server.openRead("/a.bin");
    await server.readChunk(streamId, 0);
    await server.closeRead(streamId);
    expect(stats.returned).toBe(1);
    await expect(server.readChunk(streamId, 1)).rejects.toBeInstanceOf(FilesRpcError);
    await expect(server.readChunk("nope", 0)).rejects.toMatchObject({ code: "UNKNOWN_STREAM" });
    await expect(server.closeRead("nope")).resolves.toBeUndefined();
  });

  it("a failing source fails the chunks asked after it", async () => {
    const fs = new MemFilesApi();
    fs.read = async function* () {
      yield bytes(KB);
      throw new Error("disk on fire");
    };
    const server = newFilesRpcServer({ fs, chunkSize: KB });
    const { streamId } = await server.openRead("/x");
    expect((await server.readChunk(streamId, 0)).data.length).toBe(KB);
    await expect(server.readChunk(streamId, 1)).rejects.toThrow("disk on fire");
  });
});
