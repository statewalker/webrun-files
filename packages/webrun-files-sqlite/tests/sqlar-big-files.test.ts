import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { newArchive } from "./helpers.js";

createBigFilesApiTests("SqlarFilesApi (node:sqlite)", async () => {
  const { db, files } = await newArchive();
  return { api: files, cleanup: async () => db.close() };
});
