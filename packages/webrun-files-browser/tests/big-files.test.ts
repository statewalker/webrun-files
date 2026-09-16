import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { getOriginPrivateDirectory } from "native-file-system-adapter";
// @ts-expect-error - no type declarations for this module
import * as driver from "native-file-system-adapter/src/adapters/memory.js";
import { BrowserFilesApi } from "../src/browser-files-api.js";

createBigFilesApiTests("BrowserFilesApi (memory backend)", async () => {
  const rootHandle = (await getOriginPrivateDirectory(driver)) as FileSystemDirectoryHandle;
  return { api: new BrowserFilesApi({ rootHandle }) };
});
