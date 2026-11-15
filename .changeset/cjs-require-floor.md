---
"@statewalker/webrun-files-sqlite": patch
---

The CommonJS build now `require`s `@statewalker/db-sqlite` instead of inlining it (statewalker/statewalker-root#68). So the dependency ranges move to the first releases that can be required: `@statewalker/db-sqlite` ^0.1.2 (from ^0.1.0) and `@statewalker/db-api` ^0.1.6 (from ^0.1.3). A lockfile still holding db-sqlite 0.1.0 or 0.1.1 would otherwise make `require("@statewalker/webrun-files-sqlite")` throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. db-sqlite's CommonJS entry is an ES module, so loading the CJS build needs Node's `require(esm)`: `engines` now says `node >=20.19`.
