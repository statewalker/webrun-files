// The repository's FilesApi conformance suites, run against the client over the server, through
// the transport simulator (structured clones, calls delayed and delivered out of order, stream
// calls delivered twice).
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createBigFilesApiTests, createFilesApiTests } from "@statewalker/webrun-files-tests";
import { newFilesRpcClient, newFilesRpcServer } from "../src/index.js";
import { transport } from "./helpers.js";

createFilesApiTests("FilesRpcClient over FilesRpcServer (direct)", async () => {
  const server = newFilesRpcServer({ fs: new MemFilesApi() });
  return { api: newFilesRpcClient({ rpc: server }), cleanup: () => server.close() };
});

createFilesApiTests(
  "FilesRpcClient over FilesRpcServer (cloned, reordered, duplicated)",
  async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi(), chunkSize: 4096 });
    // Calls with keys (the streams) are delivered twice; metadata calls answer for the state they
    // find, so a duplicated `remove` may report false (see the README).
    const { rpc } = transport(server, {
      maxDelay: 2,
      duplicate: 0.2,
      duplicated: (m) => !["remove", "move", "copy"].includes(m),
    });
    return {
      api: newFilesRpcClient({ rpc, chunkSize: 4096, pageSize: 3 }),
      cleanup: () => server.close(),
    };
  },
);

createBigFilesApiTests(
  "FilesRpcClient over FilesRpcServer",
  async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi() });
    const { rpc } = transport(server);
    return { api: newFilesRpcClient({ rpc }), cleanup: () => server.close() };
  },
  { size: 64 * 1024 * 1024 },
);
