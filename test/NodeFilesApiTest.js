import { NodeFilesApi } from "../src/index.js";
import fs from "node:fs/promises";
import { webcrypto } from "node:crypto";
import expect from "expect.js";
import { runFilesApiTests } from "@statewalker/webrun-files-tests"

runFilesApiTests({
  expect,
  crypto: webcrypto,
  name: "NodeFilesApi",
  newFilesApi: () =>
    new NodeFilesApi({
      fs,
      rootDir: new URL("./test-data", import.meta.url).pathname,
    }),
});


