import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { newFiles } from "./helpers.js";

createBigFilesApiTests("SqliteFilesApi (node:sqlite, web deflate)", async () => {
  const { db, files } = await newFiles();
  return { api: files, cleanup: async () => db.close() };
});

createBigFilesApiTests("SqliteFilesApi (node:sqlite, uncompressed)", async () => {
  const { db, files } = await newFiles({ compression: null });
  return { api: files, cleanup: async () => db.close() };
});
