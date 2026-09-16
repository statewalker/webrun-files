import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { NodeFilesApi } from "../src/index.js";

createBigFilesApiTests("NodeFilesApi", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "webrun-files-big-"));
  return {
    api: new NodeFilesApi({ rootDir }),
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
});
