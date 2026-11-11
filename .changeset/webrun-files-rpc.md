---
"@statewalker/webrun-files-rpc": minor
---

New package: a FilesApi over any RPC. `newFilesRpcServer({ fs })` serves any FilesApi as plain method calls and `newFilesRpcClient({ rpc })` is a FilesApi over them; reads and writes stream as chunks kept and awaited by (streamId, chunkId), so calls may be pipelined, reordered or delivered twice. Built for carrying a FilesApi over Durable Object RPC, which streams only on workerd.
