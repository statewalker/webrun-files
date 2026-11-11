// The README's examples, run as written.
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { expect, it } from "vitest";
import { newFilesRpcClient, newFilesRpcServer } from "../src/index.js";

it("README: both ends in one process", async () => {
  const server = newFilesRpcServer({ fs: new MemFilesApi() });
  const files = newFilesRpcClient({ rpc: server }); // any transport carrying these calls works

  await files.write("/notes/today.md", [new TextEncoder().encode("# Today\n")]);
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read("/notes/today.md")) chunks.push(chunk);
  expect(new TextDecoder().decode(chunks[0])).toBe("# Today\n");
});

it("README: the protocol by hand", async () => {
  const server = newFilesRpcServer({ fs: new MemFilesApi(), chunkSize: 4 });
  const streamId = crypto.randomUUID().replace(/-/g, "");
  await server.openWrite("/a.txt", { streamId });
  await Promise.all([
    server.writeChunk(streamId, 1, new TextEncoder().encode("world")), // out of order: kept
    server.writeChunk(streamId, 0, new TextEncoder().encode("hello ")),
  ]);
  await server.closeWrite(streamId, 2); // resolves once both are written, in order

  const { streamId: r } = await server.openRead("/a.txt");
  const parts: string[] = [];
  for (let chunkId = 0; ; chunkId++) {
    const { data, done } = await server.readChunk(r, chunkId);
    parts.push(new TextDecoder().decode(data));
    if (done) break;
  }
  await server.closeRead(r);
  expect(parts).toEqual(["hell", "o wo", "rld"]);
});
