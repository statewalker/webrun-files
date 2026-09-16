import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { direct } from "./helpers.js";

createFilesApiTests("HTTP stubs, direct (streamed upload)", async () => {
  const { client } = await direct({ client: { upload: "stream" } });
  return { api: client };
});

createFilesApiTests("HTTP stubs, direct (chunked upload, 257-byte parts)", async () => {
  const { client } = await direct({
    server: { minPartSize: 257 },
    client: { upload: "chunked", partSize: 257 },
  });
  return { api: client };
});

createFilesApiTests("HTTP stubs, direct (POST verbs, 2-entry pages)", async () => {
  const { client } = await direct({
    server: { methods: { http: false, post: true } },
    client: { methods: "post", pageSize: 2 },
  });
  return { api: client };
});
