import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { NodeFilesApi } from "../src/index.js";

let testDir: string;

createFilesApiTests("NodeFilesApi", async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-test-"));
  return {
    api: new NodeFilesApi({ rootDir: testDir }),
    cleanup: async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    },
  };
});
