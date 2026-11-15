---
"@statewalker/webrun-files": patch
"@statewalker/webrun-files-browser": patch
"@statewalker/webrun-files-composite": patch
"@statewalker/webrun-files-http": patch
"@statewalker/webrun-files-mem": patch
"@statewalker/webrun-files-node": patch
"@statewalker/webrun-files-rpc": patch
"@statewalker/webrun-files-s3": patch
"@statewalker/webrun-files-sqlite": patch
---

The CommonJS build has its own type declarations (`dist/cjs/*.d.cts`), and `exports` names them under `require`. TypeScript used to type `require("@statewalker/webrun-files…")` with the ESM declarations ("masquerading as ESM", attw's FalseESM). The API is unchanged.
