import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { MemFilesApi } from "../src/index.js";

createFilesApiTests("MemFilesApi", async () => ({
  api: new MemFilesApi(),
}));
