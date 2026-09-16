/**
 * A test HTTP server exposing a FilesApi over HTTP, for browsers.
 *
 * - `/api/files/*` — the server stub over an in-memory FilesApi
 * - `/`            — the page (e2e/public/index.html)
 * - `/app.js`      — its script
 * - `/lib/webrun-files-http.js` — this package's built browser bundle (dist/esm/index.js,
 *   which imports nothing, so the browser loads it as is; run `pnpm build` first)
 */
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Hono } from "hono";
import { newServerStub } from "../dist/esm/index.js";

export interface TestServer {
  url: string;
  /** The file system the stub serves. */
  fs: FilesApi;
  /** Where chunked-upload parts are staged. */
  staging: FilesApi;
  close(): Promise<void>;
}

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export async function startTestServer(
  options: { port?: number; minPartSize?: number; maxPageSize?: number } = {},
): Promise<TestServer> {
  const fs = new MemFilesApi();
  const staging = new MemFilesApi();
  const files = newServerStub({
    fs,
    staging,
    basePath: "/api/files",
    minPartSize: options.minPartSize,
    maxPageSize: options.maxPageSize,
  });

  const app = new Hono();
  app.all("/api/files", (c) => files(c.req.raw));
  app.all("/api/files/*", (c) => files(c.req.raw));
  const asset = (path: string, type: string) => async () =>
    new Response(await readFile(file(path)), {
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    });
  app.get("/", asset("./public/index.html", "text/html; charset=utf-8"));
  app.get("/app.js", asset("./public/app.js", "text/javascript; charset=utf-8"));
  app.get(
    "/lib/webrun-files-http.js",
    asset("../dist/esm/index.js", "text/javascript; charset=utf-8"),
  );

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: options.port ?? 0, hostname: "127.0.0.1" }, () =>
      resolve(s),
    );
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    fs,
    staging,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
