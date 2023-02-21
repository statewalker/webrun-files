import { NodeFilesApi } from "../src/index.js";
import fs from "node:fs/promises";
import { webcrypto } from "node:crypto";
import runFileSystemTests from "./runFileSystemTests.js";
import expect from "expect.js";

runFileSystemTests({
  expect,
  crypto: webcrypto,
  name: "NodeFilesApi",
  newFileApi: () =>
    new NodeFilesApi({
      fs,
      rootDir: new URL("./test-data", import.meta.url).pathname,
    }),
});


