---
"@statewalker/webrun-files-rpc": minor
---

Appends: `openWrite(path, { append: true })` and `FilesRpcClient.append(path, content)` add a stream's chunks to the end of a file. A served FilesApi with an `append(path, content)` method (`AppendableFilesApi`) appends through it; any other is appended to with read, write and remove only, through a temporary sibling.
