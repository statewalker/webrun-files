// The repository's FilesApi conformance suites, run against the client over the server, through
// the transport simulator (structured clones, calls delayed and delivered out of order, every call but
// remove/move/copy delivered twice at random). The big-file run is in big-files.test.ts.
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
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
    // Any call may be delivered twice but remove/move/copy: they carry no key and answer for the
    // state they find, so a duplicated `remove` may report false (see the README).
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
