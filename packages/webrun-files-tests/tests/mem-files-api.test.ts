/**
 * Tests for MemFilesApi implementation
 */

import { FilesApi, MemFilesApi } from "@statewalker/webrun-files";
import { createBigFilesApiTests } from "../src/suites/big-files.suite.js";
import { createFilesApiTests } from "../src/suites/files-api.suite.js";

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
