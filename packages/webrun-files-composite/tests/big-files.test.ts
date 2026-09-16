import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";
import { CompositeFilesApi } from "../src/index.js";

// The suite works under /big, so mounting there routes every call through the mount.
createBigFilesApiTests("CompositeFilesApi (mounted)", async () => {
  const composite = new CompositeFilesApi(new MemFilesApi());
  composite.mount("/big", new MemFilesApi());
  return { api: composite };
});
