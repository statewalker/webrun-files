/**
 * Tests for NodeFilesApi implementation
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FilesApi, NodeFilesApi } from "@statewalker/webrun-files";
import { createBigFilesApiTests } from "../src/suites/big-files.suite.js";
import { createFilesApiTests } from "../src/suites/files-api.suite.js";

createFilesApiTests("NodeFilesApi", async () => {
  // Create unique temp directory for each test
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "filesapi-test-"));

  const nodeFs = new NodeFilesApi({
    fs,
    rootDir: testDir,
  });

  return {
    api: new FilesApi(nodeFs),
    cleanup: async () => {
      // Remove test directory after each test
      await fs.rm(testDir, { recursive: true, force: true });
    },
  };
});

createBigFilesApiTests("NodeFilesApi", async () => {
  // Create unique temp directory for each test
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "filesapi-bigtest-"));

  const nodeFs = new NodeFilesApi({
    fs,
    rootDir: testDir,
  });

  return {
    api: new FilesApi(nodeFs),
    cleanup: async () => {
      // Remove test directory after each test
      await fs.rm(testDir, { recursive: true, force: true });
    },
  };
});
