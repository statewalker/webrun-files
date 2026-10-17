import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { newFiles } from "./helpers.js";

createFilesApiTests("SqliteFilesApi (Durable Object)", async () => {
  const { db, files } = await newFiles({ driver: "do", blockSize: 4096 });
  return { api: files, cleanup: async () => db.close() };
});
