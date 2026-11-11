---
"@statewalker/webrun-files-rpc": minor
---

New package: a FilesApi over any RPC. `newFilesRpcServer({ fs })` serves any FilesApi as plain method calls and `newFilesRpcClient({ rpc })` is a FilesApi over them; reads and writes stream as chunks kept and awaited by (streamId, chunkId), so calls may be pipelined, reordered or delivered twice. Moved from statewalker-sandbox, where it carries the file capability of flue-capfs-do over Durable Object RPC.
