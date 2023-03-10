import { MemFilesApi } from "../src/index.js";
import { webcrypto } from "node:crypto";
import { runFilesApiTests } from "@statewalker/webrun-files-tests"
import expect from "expect.js";

runFilesApiTests({
  expect,
  crypto : webcrypto,
  name: "MemFilesApi",
  newFilesApi: () => new MemFilesApi({}),
});