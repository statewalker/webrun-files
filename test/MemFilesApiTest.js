import { MemFilesApi } from "../src/index.js";
import { webcrypto } from "node:crypto";
import runFileSystemTests from "./runFileSystemTests.js";
import expect from "expect.js";

runFileSystemTests({
  expect,
  crypto : webcrypto,
  name: "MemFilesApi",
  newFileApi: () => new MemFilesApi({}),
});