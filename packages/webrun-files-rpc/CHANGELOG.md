# @statewalker/webrun-files-rpc

## 0.1.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md, dist/cjs/index.cjs, dist/client.d.ts, dist/client.d.ts.map, dist/errors.d.ts.map, 12 more

## 0.1.0

### Minor Changes

- 844226f: Appends: `openWrite(path, { append: true })` and `FilesRpcClient.append(path, content)` add a stream's chunks to the end of a file. A served FilesApi with an `append(path, content)` method (`AppendableFilesApi`) appends through it; any other is appended to with read, write and remove only, through a temporary sibling.
  
  Metadata calls (`mkdir`, `remove`, `move`, `copy`) take an optional `requestId`: the server keeps each answer for `idleTimeout` (at most `maxRequests`), so a call delivered twice runs once and gets the first answer. The client sends one with every such call.
- 8ec21d1: New package: a FilesApi over any RPC. `newFilesRpcServer({ fs })` serves any FilesApi as plain method calls and `newFilesRpcClient({ rpc })` is a FilesApi over them; reads and writes stream as chunks kept and awaited by (streamId, chunkId), so calls may be pipelined, reordered or delivered twice. Built for carrying a FilesApi over Durable Object RPC, which streams only on workerd.

### Patch Changes

- 7e5d5f5: Fixes: a metadata call still running keeps its `requestId`, past `idleTimeout` and past `maxRequests` (the oldest settled answer is forgotten first), so a retry delivered meanwhile no longer runs it a second time; a read takes its listener off its `signal` when it ends, fails or is aborted (a long-lived signal no longer gathers one per read); `errorCode(e)` returns only protocol codes, not another error's own `code` (such as `ENOENT`).
- Updated dependencies
  - @statewalker/webrun-files@0.10.4
