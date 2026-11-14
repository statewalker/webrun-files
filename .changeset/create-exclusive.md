---
"@statewalker/webrun-files": minor
"@statewalker/webrun-files-mem": minor
"@statewalker/webrun-files-node": minor
"@statewalker/webrun-files-browser": minor
"@statewalker/webrun-files-sqlite": minor
"@statewalker/webrun-files-s3": minor
"@statewalker/webrun-files-composite": minor
---

`FilesApi` gains an optional `createExclusive(path, content): Promise<boolean>`: create the file only if nothing exists at the path, atomically, so that of concurrent calls for one path at most one returns `true`. It returns `false`, writing no file, for an existing file, directory or link; creates parent directories (which may stay even when it returns `false`); and removes the file again when the content fails. Only the creation is atomic: on some backends (node) readers can see partial content until the call completes, so callers that need atomic content create a temporary file and move it. It is the primitive behind lock files (git's `index.lock`). Being optional, existing implementations keep compiling; callers feature-detect it.

- `NodeFilesApi`: `open(path, "wx")` (`O_CREAT | O_EXCL`), streamed in 64 KiB batches; excludes every process on the filesystem. A symbolic link, even a dangling one, counts as existing. A failed source unlinks the path, as git does.
- `MemFilesApi`: a synchronous check and reservation; excludes callers sharing the instance. The file stays invisible until complete, and a file at an ancestor of the path makes the call return `false`.
- `BrowserFilesApi`: the check and create run under a Web Lock (`navigator.locks`) asked for `ifAvailable`, excluding every tab and worker of the origin; a call that finds the lock held returns `false` at once. Without Web Locks, an in-memory lock excludes only the current realm. Under an OPFS root the lock is named by the file's full OPFS path, so instances rooted at different OPFS directories share it; elsewhere, the new option `lockScope` names the directory for instances built on separately obtained handles.
- `SqliteFilesApi` and `SqlarFilesApi`: `INSERT ... ON CONFLICT DO NOTHING`; excludes every connection to the database. Nothing is visible until complete.
- `S3FilesApi`: `If-None-Match: *` on the final `PutObject` or `CompleteMultipartUpload` (412 returns `false`, 409 is retried); excludes every client of the bucket on services that honour conditional writes (AWS S3 since 2024, RustFS).
- `CompositeFilesApi` has the method only while every backend has it, and delegates to the owning backend; `GuardedFilesApi` (checked as a `write`) and `FilteredFilesApi` have it while what they wrap has it. Presence, `in` included, is checked at each access, so a wrapper over a composite loses the method when a `mount()` adds a backend without it.

`webrun-files-http` and `webrun-files-rpc` do not offer it: neither protocol has a conditional create.
