
# @statewalker/webrun-files-tests

This package contains a set of common tests for all FilesApi (@statewalker/webrun-files) implementations.

## Usage

```js
// Import a batch of common tests
import { runFilesApiTests } from "@statewalker/webrun-files-tests";

// Import a specific FilesApi implementation
import { MemFilesApi } from "@statewalker/webrun-files";

// Import expect.js
import expect from "expect.js";s
// Import crypto library (used to calculate content hashes - SHA1).
import crypto from "crypto";

// Run tests on the specified FilesApi instance. This method provids all required dependencies.
runFilesApiTests({
  
  // Human-readable name of this set of tests:
  name : "MemFilesApi",

  // This method returns a FilesApi instance to test:
  newFilesApi : () => new MemFilesApi(),

  // An instance of the "expect.js" testing library:
  expect,

  // Standard crypto instance. Used to calculate SHA-1 hashes of files content:
  crypto
})

```

