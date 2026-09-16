import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { newFiles } from "./helpers.js";

createFilesApiTests("SqliteFilesApi (node:sqlite, uncompressed)", async () => {
  const { db, files } = await newFiles({ compression: null });
  return { api: files, cleanup: async () => db.close() };
});
