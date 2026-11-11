// The repository's big-file suite on the client over the server, every call structured-cloned
// (the transport simulator with no delays or duplicates). 64 MiB: the chunks are 256 KiB, so it is still 256 round trips
// each way, and the suite's 256 MiB default would only make the run slower.
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { newFilesRpcClient, newFilesRpcServer } from "../src/index.js";
import { transport } from "./helpers.js";

createBigFilesApiTests(
  "FilesRpcClient over FilesRpcServer",
  async () => {
    const server = newFilesRpcServer({ fs: new MemFilesApi() });
    const { rpc } = transport(server);
    return { api: newFilesRpcClient({ rpc }), cleanup: () => server.close() };
  },
  { size: 64 * 1024 * 1024 },
);
