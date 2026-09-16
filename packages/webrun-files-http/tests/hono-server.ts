import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Hono } from "hono";
import {
  type ClientStubOptions,
  newClientStub,
  newServerStub,
  type ServerStubOptions,
} from "../src/index.js";

/** The server stub mounted in Hono under /api/files, on a real ephemeral port. */
export async function overHttp(
  options: {
    fs?: FilesApi;
    server?: Partial<ServerStubOptions>;
    client?: Partial<ClientStubOptions>;
  } = {},
) {
  const fs = options.fs ?? new MemFilesApi();
  const handler = newServerStub({ fs, basePath: "/api/files", ...options.server });
  const app = new Hono();
  app.all("/api/files", (c) => handler(c.req.raw));
  app.all("/api/files/*", (c) => handler(c.req.raw));

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const client = await newClientStub({
    baseUrl: `http://127.0.0.1:${port}/api/files`,
    ...options.client,
  });
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  return { fs, client, port, close };
}
