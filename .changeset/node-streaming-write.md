---
"@statewalker/webrun-files-node": minor
---

`NodeFilesApi.write` streams: chunks go (batched to 64 KiB) to a temporary file beside the target, which is renamed over the target once the content has ended. Memory stays at about 64 KiB plus one chunk instead of the whole file, a source that fails leaves the old file in place, and a file can be rewritten from its own `read`. Replacing keeps the old file's mode and writes through a symbolic link to its target; a hard link is replaced rather than written through, and owner, ACLs and extended attributes are those of a new file. Temporaries are named `.webrun-tmp-<random>` and hidden from `list`; a crash can leave one behind. `write("/")` is refused. Also fixed: a `NodeFilesApi` rooted at `/` refused every path.
