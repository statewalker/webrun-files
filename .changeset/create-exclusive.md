---
"@statewalker/webrun-files": minor
"@statewalker/webrun-files-mem": minor
"@statewalker/webrun-files-node": minor
"@statewalker/webrun-files-browser": minor
"@statewalker/webrun-files-sqlite": minor
"@statewalker/webrun-files-s3": minor
"@statewalker/webrun-files-composite": minor
---

`FilesApi` gains an optional `createExclusive(path, content): Promise<boolean>`: create the file only if nothing exists at the path, atomically, so that of concurrent calls for one path exactly one returns `true`. It returns `false`, writing nothing, for an existing file, directory or link; creates parent directories; and removes the file again when the content fails. It is the primitive behind lock files (git's `index.lock`). Being optional, existing implementations keep compiling; callers feature-detect it.

- `NodeFilesApi`: `open(path, "wx")` (`O_CREAT | O_EXCL`), streamed in 64 KiB batches; excludes every process on the filesystem. A symbolic link, even a dangling one, counts as existing.
- `MemFilesApi`: a synchronous check and reservation; excludes callers sharing the instance. The file stays invisible until complete.
- `BrowserFilesApi`: the check and create run under a Web Lock (`navigator.locks`) named after the directory and path, excluding every tab and worker of the origin; without Web Locks, an in-memory mutex excludes only the current realm. New option `lockScope` names the directory in the lock for instances built on separately obtained handles; a directory in OPFS is named by its path there.
- `SqliteFilesApi` and `SqlarFilesApi`: `INSERT ... ON CONFLICT DO NOTHING`; excludes every connection to the database. Nothing is visible until complete.
- `S3FilesApi`: `If-None-Match: *` on the final `PutObject` or `CompleteMultipartUpload` (412 returns `false`, 409 is retried); excludes every client of the bucket on services that honour conditional writes (AWS S3 since 2024, RustFS).
- `CompositeFilesApi` has the method only while every backend has it, and delegates to the owning backend; `GuardedFilesApi` (checked as a `write`) and `FilteredFilesApi` have it when what they wrap has it.

`webrun-files-http` and `webrun-files-rpc` do not offer it: neither protocol has a conditional create.
