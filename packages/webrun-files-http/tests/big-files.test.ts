import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { direct } from "./helpers.js";
import { overHttp } from "./hono-server.js";

createBigFilesApiTests("HTTP stubs, direct (streamed upload)", async () => {
  const { client } = await direct({ client: { upload: "stream" } });
  return { api: client };
});

createBigFilesApiTests("HTTP stubs, direct (chunked upload, 5 MiB parts)", async () => {
  const { client } = await direct({ client: { upload: "chunked" } });
  return { api: client };
});

createBigFilesApiTests("HTTP stubs over @hono/node-server (streamed upload)", async () => {
  const { client, close } = await overHttp({ client: { upload: "stream" } });
  return { api: client, cleanup: close };
});

createBigFilesApiTests(
  "HTTP stubs over @hono/node-server (chunked upload, 5 MiB parts)",
  async () => {
    const { client, close } = await overHttp({ client: { upload: "chunked" } });
    return { api: client, cleanup: close };
  },
);
