import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  type ClientStubOptions,
  type FetchHandler,
  newClientStub,
  newServerStub,
  type ServerStubOptions,
} from "../src/index.js";

export const BASE_URL = "http://files.test/api/files";

/** A client whose fetch is the server stub itself: no network, same Request/Response objects. */
export async function direct(
  options: {
    fs?: FilesApi;
    server?: Partial<ServerStubOptions>;
    client?: Partial<ClientStubOptions>;
    wrapFetch?: (fetch: FetchHandler) => FetchHandler;
  } = {},
) {
  const fs = options.fs ?? new MemFilesApi();
  const server = newServerStub({ fs, basePath: "/api/files", ...options.server });
  const fetch = options.wrapFetch ? options.wrapFetch(server) : server;
  const client = await newClientStub({ baseUrl: BASE_URL, fetch, ...options.client });
  return { fs, server, client };
}
