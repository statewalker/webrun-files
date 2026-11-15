---
"@statewalker/webrun-files": minor
"@statewalker/webrun-files-rpc": minor
"@statewalker/webrun-files-http": minor
"@statewalker/webrun-files-composite": patch
"@statewalker/webrun-files-node": patch
"@statewalker/webrun-files-mem": patch
"@statewalker/webrun-files-s3": patch
"@statewalker/webrun-files-sqlite": patch
"@statewalker/webrun-files-browser": patch
---

Security: `..` segments no longer slip past path filters, guards and composite mounts (#40).

`normalizePath` now resolves `..` (`/a/../b` is `/b`) and throws `Path climbs above the root: <path>`
when one would climb above the root (`/../x`). Its result never holds a `..`, so `FilteredFilesApi`,
`GuardedFilesApi` and `CompositeFilesApi` decide on the same path the backend acts on: over a node
backend, `/x/../.git/config` used to pass a `/.git` filter and `/m/../y` used to escape a mount.
`joinPath`, `dirname` and `basename` follow. The RPC server refuses an escaping append instead of
clamping it; the HTTP client sends `/a/../b` as `/b` instead of refusing it.

Migration: keys already stored in mem, S3 or SQLite with a literal `..` segment become unreachable
through the API; rename them with a direct tool before upgrading. Rollback: pin the previous minor.
