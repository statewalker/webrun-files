/**
 * Tests for MemFilesApi implementation
 */

import { createBigFilesApiTests, createFilesApiTests } from "@statewalker/webrun-files-tests";
import { FilesApi, MemFilesApi } from "../src/index.js";

createFilesApiTests("MemFilesApi", async () => ({
  api: new FilesApi(new MemFilesApi()),
  cleanup: async () => {
    // Memory implementation needs no cleanup
  },
}));

createBigFilesApiTests("MemFilesApi", async () => ({
  api: new FilesApi(new MemFilesApi()),
  cleanup: async () => {
    // Memory implementation needs no cleanup
  },
}));
