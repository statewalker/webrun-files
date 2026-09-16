---
"@statewalker/webrun-files": minor
"@statewalker/webrun-files-mem": minor
"@statewalker/webrun-files-node": minor
"@statewalker/webrun-files-browser": minor
"@statewalker/webrun-files-s3": minor
"@statewalker/webrun-files-composite": minor
"@statewalker/webrun-files-sqlite": minor
---

Ordered listings and `ListOptions.after`. Every `list()` now yields entries in strictly increasing
path order, compared by Unicode code point (UTF-8 byte order), recursively or not, and
`{ after: path }` resumes after any path, existing or not. The core package adds `comparePaths`,
`listInPathOrder` and `mergeInPathOrder`.

Behaviour changes: listings that previously came out in backend order (Node `readdir`, browser
handles, memory insertion order, S3 prefixes before keys, composite mounts last) are now sorted; a
`CompositeFilesApi` mount point replaces a same-path entry of the parent backend in listings; an S3
key `a` and keys under `a/` list `/a` once, as the file.
