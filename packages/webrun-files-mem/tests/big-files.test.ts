import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { MemFilesApi } from "../src/index.js";

createBigFilesApiTests("MemFilesApi", async () => ({ api: new MemFilesApi() }));
