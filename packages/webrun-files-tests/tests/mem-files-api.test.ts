/**
 * Tests for MemFilesApi implementation
 */

import { FilesApi, MemFilesApi } from "@statewalker/webrun-files";
import { createFilesApiTests } from "../src/suites/files-api.suite.js";

createFilesApiTests("MemFilesApi", async () => ({
  api: new FilesApi(new MemFilesApi()),
  cleanup: async () => {
    // Memory implementation needs no cleanup
  },
}));
