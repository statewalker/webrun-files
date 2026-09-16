import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { pakoDeflateCodec } from "../../src/index.js";
import { newFiles } from "./helpers.js";

createFilesApiTests("SqliteFilesApi (node:sqlite, uncompressed)", async () => {
  const { db, files } = await newFiles({ compression: null });
  return { api: files, cleanup: async () => db.close() };
});

createFilesApiTests("SqliteFilesApi (node:sqlite, default web deflate)", async () => {
  const { db, files } = await newFiles();
  return { api: files, cleanup: async () => db.close() };
});

createFilesApiTests("SqliteFilesApi (node:sqlite, pako deflate, small blocks)", async () => {
  const { db, files } = await newFiles({
    compression: pakoDeflateCodec(pako),
    minBlockSize: 64,
    maxBlockSize: 1024,
  });
  return { api: files, cleanup: async () => db.close() };
});
